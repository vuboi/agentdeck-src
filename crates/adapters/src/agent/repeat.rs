//! Ends a turn that makes the same tool call again and again with the same input. A CLI can load a tool's schema and
//! still never call it (it reads the schema, then reads it again): such a turn loops until the user stops it, and
//! nothing else in the stream says it is stuck. Kept apart from the runner so the rule can be tested alone.

/// How many identical calls in a row end the turn. Long enough that a poll with the same arguments, a few times, is
/// not mistaken for a loop.
pub const SAME_CALL_LIMIT: usize = 8;

/// The last tool call seen and how many times in a row it came back unchanged.
#[derive(Debug, Default)]
pub struct RepeatGuard {
    last: Option<(String, String)>,
    count: usize,
}

impl RepeatGuard {
    /// Notes one tool call. True when it is the `SAME_CALL_LIMIT`-th identical call in a row.
    pub fn note(&mut self, name: &str, input: &str) -> bool {
        let same = self
            .last
            .as_ref()
            .is_some_and(|(last_name, last_input)| last_name == name && last_input == input);
        if same {
            self.count += 1;
        } else {
            self.last = Some((name.to_owned(), input.to_owned()));
            self.count = 1;
        }
        self.count >= SAME_CALL_LIMIT
    }
}

/// What the user is shown when the guard ends a turn.
pub fn message(name: &str) -> String {
    format!(
        "Stopped: the model called {name} {SAME_CALL_LIMIT} times in a row with the same input and made no progress. \
         The tool may not be callable in this chat. Ask again, or name the tool to use directly."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_th_identical_call_in_a_row_ends_the_turn() {
        let mut guard = RepeatGuard::default();
        for _ in 1..SAME_CALL_LIMIT {
            assert!(!guard.note("search_tools", "select:x"));
        }
        assert!(guard.note("search_tools", "select:x"));
    }

    #[test]
    fn a_different_call_starts_the_count_again() {
        let mut guard = RepeatGuard::default();
        for _ in 0..SAME_CALL_LIMIT - 1 {
            guard.note("search_tools", "select:x");
        }
        assert!(!guard.note("Bash", "ls"));
        assert!(!guard.note("search_tools", "select:x"));
    }
}
