#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorState {
    Created,
    Running,
    Stalled,
    Stopping,
    Exited,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorEvent {
    Started,
    StderrDrained(usize),
    StallDetected,
    Restarted(u32),
    TreeCleanup,
    Exited,
    Failed,
}
#[derive(Debug)]
pub struct ProcessSupervisor {
    state: SupervisorState,
    restart_count: u32,
    max_restarts: u32,
    stderr_bytes: usize,
}
impl ProcessSupervisor {
    pub fn new(max_restarts: u32) -> Self {
        Self {
            state: SupervisorState::Created,
            restart_count: 0,
            max_restarts,
            stderr_bytes: 0,
        }
    }
    pub fn start(&mut self) {
        self.state = SupervisorState::Running;
    }
    pub fn drain_stderr(&mut self, bytes: usize) {
        self.stderr_bytes += bytes;
    }
    pub fn mark_stalled(&mut self) {
        if self.state == SupervisorState::Running {
            self.state = SupervisorState::Stalled;
        }
    }
    pub fn restart(&mut self) -> bool {
        if self.restart_count >= self.max_restarts {
            self.state = SupervisorState::Failed;
            return false;
        }
        self.restart_count += 1;
        self.state = SupervisorState::Running;
        true
    }

    /// Restarts only after the old process has exited. DSH SDK resume cannot safely reuse a
    /// session lock while the previous sidecar is still alive.
    pub fn restart_after_exit(&mut self) -> bool {
        if self.state != SupervisorState::Exited {
            return false;
        }
        self.restart()
    }
    pub fn cleanup_tree(&mut self) {
        self.state = SupervisorState::Stopping;
    }
    pub fn exited(&mut self) {
        self.state = SupervisorState::Exited;
    }
    pub fn state(&self) -> SupervisorState {
        self.state
    }
    pub fn restart_count(&self) -> u32 {
        self.restart_count
    }
    pub fn stderr_bytes(&self) -> usize {
        self.stderr_bytes
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_is_bounded_and_stderr_is_accounted() {
        let mut s = ProcessSupervisor::new(1);
        s.start();
        s.drain_stderr(12);
        s.mark_stalled();
        assert!(s.restart());
        assert!(!s.restart());
        assert_eq!(s.state(), SupervisorState::Failed);
        assert_eq!(s.stderr_bytes(), 12);
    }

    #[test]
    fn resume_restart_waits_for_process_exit() {
        let mut s = ProcessSupervisor::new(1);
        s.start();
        s.cleanup_tree();
        assert!(!s.restart_after_exit());
        assert_eq!(s.state(), SupervisorState::Stopping);
        s.exited();
        assert!(s.restart_after_exit());
        assert_eq!(s.state(), SupervisorState::Running);
    }
}
