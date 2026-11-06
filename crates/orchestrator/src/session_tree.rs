use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionNode {
    pub session_id: String,
    pub parent_id: Option<String>,
    pub active: bool,
}
#[derive(Debug, Default)]
pub struct SessionRuntimeTree {
    nodes: BTreeMap<String, SessionNode>,
}
impl SessionRuntimeTree {
    pub fn start(&mut self, session_id: impl Into<String>, parent_id: Option<String>) -> bool {
        let id = session_id.into();
        if self.nodes.contains_key(&id) {
            return false;
        }
        self.nodes.insert(
            id.clone(),
            SessionNode {
                session_id: id,
                parent_id,
                active: true,
            },
        );
        true
    }
    pub fn finish(&mut self, session_id: &str) -> bool {
        self.nodes
            .get_mut(session_id)
            .map(|n| {
                n.active = false;
                true
            })
            .unwrap_or(false)
    }
    pub fn cleanup(&mut self, session_id: &str) -> Vec<String> {
        let mut removed = Vec::new();
        let mut stack = vec![session_id.to_string()];
        while let Some(id) = stack.pop() {
            let children: Vec<_> = self
                .nodes
                .values()
                .filter(|n| n.parent_id.as_deref() == Some(&id))
                .map(|n| n.session_id.clone())
                .collect();
            stack.extend(children);
            if self.nodes.remove(&id).is_some() {
                removed.push(id);
            }
        }
        removed
    }
    pub fn get(&self, id: &str) -> Option<&SessionNode> {
        self.nodes.get(id)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_removes_child_subtree() {
        let mut tree = SessionRuntimeTree::default();
        assert!(tree.start("p", None));
        assert!(tree.start("c", Some("p".into())));
        assert_eq!(tree.cleanup("p"), vec!["p", "c"]);
        assert!(tree.get("c").is_none());
    }
}
