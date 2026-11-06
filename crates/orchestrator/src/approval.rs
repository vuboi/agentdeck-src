use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub request_id: String,
    pub provider: String,
    pub session_id: String,
    pub turn_id: String,
    pub expires_at: u64,
    pub attempts: u32,
    pub status: ApprovalStatus,
}
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ApprovalError {
    #[error("approval request already exists: {0}")]
    Duplicate(String),
    #[error("approval request not found: {0}")]
    NotFound(String),
    #[error("approval request is not pending: {0}")]
    NotPending(String),
}
#[derive(Debug, Default)]
pub struct ApprovalBroker {
    records: BTreeMap<String, ApprovalRecord>,
}
impl ApprovalBroker {
    pub fn request(
        &mut self,
        request_id: impl Into<String>,
        provider: impl Into<String>,
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        expires_at: u64,
    ) -> Result<&ApprovalRecord, ApprovalError> {
        let request_id = request_id.into();
        if self.records.contains_key(&request_id) {
            return Err(ApprovalError::Duplicate(request_id));
        }
        let record = ApprovalRecord {
            request_id: request_id.clone(),
            provider: provider.into(),
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            expires_at,
            attempts: 0,
            status: ApprovalStatus::Pending,
        };
        self.records.insert(request_id.clone(), record);
        Ok(self.records.get(&request_id).unwrap())
    }
    pub fn resolve(
        &mut self,
        request_id: &str,
        approved: bool,
    ) -> Result<&ApprovalRecord, ApprovalError> {
        let record = self
            .records
            .get_mut(request_id)
            .ok_or_else(|| ApprovalError::NotFound(request_id.into()))?;
        if record.status != ApprovalStatus::Pending {
            return Err(ApprovalError::NotPending(request_id.into()));
        }
        record.status = if approved {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        Ok(record)
    }
    pub fn retry_transport(&mut self, request_id: &str) -> Result<u32, ApprovalError> {
        let record = self
            .records
            .get_mut(request_id)
            .ok_or_else(|| ApprovalError::NotFound(request_id.into()))?;
        if record.status != ApprovalStatus::Pending {
            return Err(ApprovalError::NotPending(request_id.into()));
        }
        record.attempts += 1;
        Ok(record.attempts)
    }
    pub fn expire_due(&mut self, now: u64) -> usize {
        let mut count = 0;
        for record in self.records.values_mut() {
            if record.status == ApprovalStatus::Pending && record.expires_at <= now {
                record.status = ApprovalStatus::Expired;
                count += 1;
            }
        }
        count
    }
    pub fn get(&self, request_id: &str) -> Option<&ApprovalRecord> {
        self.records.get(request_id)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn correlation_expiry_and_retry_are_deterministic() {
        let mut b = ApprovalBroker::default();
        b.request("a", "dsh", "s", "t", 10).unwrap();
        assert_eq!(b.retry_transport("a").unwrap(), 1);
        assert_eq!(b.expire_due(10), 1);
        assert_eq!(
            b.resolve("a", true),
            Err(ApprovalError::NotPending("a".into()))
        );
    }
}
