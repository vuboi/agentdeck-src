---
title: Nối luồng plan → tách worker song song (worktree, role, merge)
status: draft
agent: 
chat: claude:073c96b9-c350-47de-85f0-5e37675b4cdd
source: mcp
created: 2026-11-06T18:20:40.008Z
updated: 2026-11-06T18:20:40.008Z
---
# Nối luồng plan → tách worker song song

Mục tiêu: plan được duyệt thì agent tự đề xuất tách việc song song (worktree), gán role BE/FE cho từng step, worker trao đổi requirement, và tích hợp kết quả về một nhánh.

- [ ] Plan duyệt kích hoạt gợi ý tách việc
  - files: apps/desktop/src/lib/plans/plan-gate.svelte.ts, apps/desktop/src/lib/components/chat/Composer.svelte
  - verify: duyệt plan có 2+ step file rời nhau → agent nhận prompt yêu cầu cân nhắc propose_session
  - evidence: (chưa)
- [ ] Trường role trên step của plan
  - files: apps/desktop/src-tauri/src/plans.rs, apps/desktop/src/lib/plans/plans.svelte.ts
  - verify: step `- [ ] (BE) ...` được parse thành role; step không có role giữ hành vi cũ
  - evidence: (chưa)
- [ ] propose_session lấy write_scope từ files: của step
  - files: apps/desktop/src/lib/tasks/propose.ts, apps/desktop/src/lib/tasks/propose.test.ts
  - verify: test: 2 step file rời → proposal không báo trùng; 2 step chung file → báo trùng
  - evidence: (chưa)
- [ ] Phụ thuộc BE → FE qua merge trung gian
  - files: apps/desktop/src/lib/tasks/delegate-plan.ts, apps/desktop/src/lib/tasks/worktree.ts
  - verify: worker FE có depends_on BE → chờ BE xong, merge nhánh BE vào base, rồi tạo worktree FE từ base mới
  - evidence: (chưa)
- [ ] Requirement giữa worker BE/FE bền hơn team_message
  - files: apps/desktop/src/lib/chat/session/delegate-task.svelte.ts
  - verify: note gửi tới worker đã xong vẫn được giữ và giao khi worker chạy lại; không mất im lặng
  - evidence: (chưa)
- [ ] Tích hợp kết quả nhiều worker về một nhánh
  - files: apps/desktop/src/lib/chat/session/worktree-actions.ts, apps/desktop/src/lib/components/tasks/DelegateList.svelte
  - verify: nút "Merge all" merge theo thứ tự, conflict dừng và báo file; không merge khi worker còn dirty
  - evidence: (chưa)
- [ ] Worker nhận memory dự án và plan
  - files: apps/desktop/src/lib/chat/session/delegate-task.svelte.ts
  - verify: worker turn có memoryHint và plan_list hint như chat chính
  - evidence: (chưa)
- [ ] Dọn worktree tồn đọng
  - files: (không đổi code; chạy git worktree prune sau khi user đồng ý)
  - verify: git worktree list không còn agentdeck-merge prunable
  - evidence: (chưa)

Ràng buộc: không đổi hành vi shared isolation; mỗi bước có test Rust (cargo test) và node test trong apps/desktop; cargo clippy --workspace -- -D warnings và svelte-check phải sạch.
