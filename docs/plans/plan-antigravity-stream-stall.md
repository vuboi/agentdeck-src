# Kế hoạch: Antigravity dừng sau 1–2 lệnh và trạng thái chat nhảy dòng

Ngày: 2026-11-03. Trạng thái: đã triển khai các sửa lỗi stream, lifecycle activity và layout; runtime Antigravity native vẫn cần lượt tái hiện thực tế để xác nhận end-to-end.

## Mục tiêu và tiêu chí hoàn thành

- Một turn Antigravity chạy tiếp sau command đầu tiên, hoặc kết thúc với kết quả/lỗi rõ ràng; không đứng vô hạn ở `Running command`.
- Dòng trạng thái command không xuống hàng hoặc đẩy nội dung khi thời gian chạy tăng. Lệnh dài được cắt gọn theo chiều rộng có sẵn.
- Khi response đang stream, khoảng ngừng giữa các text delta không làm `Thinking` hiện rồi biến mất bên dưới. Trạng thái đổi theo event, không theo một ngưỡng thời gian chung.
- Stop, lỗi tool và command chạy lâu hợp lệ vẫn có hành vi đúng.

## Hiện trạng đã xác minh trong code

- `antigravity.rs`: mỗi turn chạy một process `agy -p ... --output-format stream-json`; `step_update` với `ACTIVE` phát `ToolCall`, `DONE`/`ERROR` phát `ToolResult`, `result` kết thúc turn. `--print-timeout 30m` là giới hạn của CLI, không chứng minh một lệnh đã treo.
- `warm.rs` đọc stdout, theo dõi process, cập nhật watchdog và phát event. Cần đối chiếu log của đúng turn để biết event bị mất ở CLI, adapter, runner hay frontend.
- `CommandGroup.svelte` đặt `runningLine` vào `SwapLine`; cùng hàng còn có đồng hồ, chip và nút mở rộng. `SwapLine.svelte` đo text rồi đặt width và chuyển tiếp width. Chưa xác định chính xác yếu tố làm hàng xuống dòng.
- `AssistantMessage.svelte` trước đây dùng `TEXT_IDLE_S = 2` để tự đổi `Writing reply` sang `Thinking` khi text ngừng 2 giây. Đã bỏ nhánh này: khi response còn stream, khoảng ngừng không tự đổi trạng thái. `pnpm --filter desktop check` đạt 0 lỗi, 3 cảnh báo có sẵn ở file khác; Prettier và `git diff --check` đạt. Chưa có xác nhận runtime với Antigravity.
- Activity từng giữ mọi item có `background: true` sau `done`, nên lệnh foreground được UI promote vì chạy lâu không được đóng. Lifecycle hiện phân biệt `launchedInBackground` của provider với trạng thái background tạm của UI.
- Hàng command có `min-w-0`, vùng text `flex-1` và `whitespace-nowrap`; `SwapLine` nhận `containerClass` để phần text co theo chiều rộng còn lại và truncate.

## Bước 1 — Thu bằng chứng cho lượt bị dừng

1. Ghi phiên bản app đang chạy, chat/turn và mốc thời gian Enter, command đầu, thời điểm ngừng tiến triển. Đọc `debug.log` và `audit.jsonl` quanh mốc đó. Audit chỉ chứa lời gọi đã hoàn tất nên không dùng riêng audit để kết luận command đang chạy.
2. Đối chiếu event cuối: JSON từ `agy` (`init`, `step_update`, `result`), `AgentEvent` sau parse, sự kiện runner phát sang chat, và block command ở frontend. Ghi process còn sống hay đã thoát, stdout/stderr còn tăng hay không.
3. Nếu log hiện tại thiếu ranh giới nào, thêm log hẹp tại ranh giới đó: turn ID, step index, state, loại event, thời điểm và trạng thái process; không ghi prompt hoặc nội dung nhạy cảm. Tái hiện một lần rồi đọc log mới.

Điều kiện qua bước: xác định ranh giới đầu tiên mà trạng thái `ACTIVE` không có kết thúc hoặc kết thúc không tới UI. Không sửa bằng cách tăng timeout khi chưa có bằng chứng.

## Bước 2 — Sửa đúng ranh giới bị kẹt

| Bằng chứng                                                 | Cách sửa                                                                                                                             | Kiểm chứng                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `agy` phát `DONE`/`ERROR`, adapter không phát `ToolResult` | Sửa parser `step_update` trong `antigravity.rs`, giữ ID theo `step_index`; chỉ thêm biến thể event thực tế tìm thấy trong log        | `ACTIVE → DONE`, `ACTIVE → ERROR` đóng đúng command                     |
| Adapter phát `ToolResult`, block vẫn `running`             | Sửa đường áp event vào command trong `agent-reply.ts` hoặc nơi định tuyến event nếu ID bị đổi/mất                                    | UI đóng đúng command, command sau xuất hiện                             |
| Process đã thoát nhưng turn chưa đóng                      | Sửa nhánh EOF/exit trong runner để phát lỗi hoặc kết thúc và thu dọn command còn mở                                                  | Không còn spinner vô hạn; Stop và turn mới hoạt động                    |
| Process còn sống nhưng không phát event                    | Kiểm tra lệnh con, quyền, stdin/stdout và watchdog theo log; thêm xử lý stall có thông báo và cleanup tại runner nếu CLI thực sự kẹt | Lệnh chạy lâu hợp lệ không bị ngắt sớm; lệnh kẹt có kết quả lỗi rõ ràng |

Giữ bản sửa nhỏ nhất ở nhánh đã chứng minh. Không gộp bản sửa runtime với thay đổi layout.

## Bước 3 — Sửa dòng `Running command` xuống hàng

1. Chụp cùng một turn ngay khi command bắt đầu, trước và sau thời điểm xuống hàng. Đo chiều rộng hàng, `SwapLine`, text thực tế, đồng hồ và chip; kiểm tra có event làm `runningLine` đổi hay chỉ layout đổi.
2. Nếu do hàng command: đặt vùng text `min-width: 0`, cho nó nhận phần chiều rộng còn lại và `truncate`; giữ đồng hồ/icon không co. Nếu do `SwapLine`: chặn width đo được vượt vùng chứa và bảo đảm transition không làm hàng cha tràn. Sửa đúng component gây lỗi, dùng token/style hiện có.
3. So với hàng command lân cận trên Preview. Kiểm tra command ngắn, command dài, cửa sổ hẹp, thời gian chạy tăng và lúc chuyển `Running → Ran`.

## Bước 4 — Xác nhận stream text và hoàn tất

1. Tái hiện stream có các khoảng ngừng ngắn và dài hơn 2 giây. `Thinking` không được chèn dưới text chỉ vì đồng hồ chạy; chỉ event chuyển pha mới đổi trạng thái.
2. Tái hiện chuỗi `text → tool → text → done`, tool lỗi và Stop. Kiểm tra không có hai dòng trạng thái sống cùng lúc hoặc nội dung bị đẩy lên xuống.
3. Đã chạy test activity/reducer: 17/17 pass; `svelte-check` trực tiếp đạt 0 lỗi và 3 cảnh báo có sẵn ở `Markdown.svelte`/`Tree.svelte`; `git diff --check` pass. Wrapper `pnpm` không chạy được vì shim `mise` thiếu executable. Chưa sửa Rust nên chưa chạy clippy.

## Giới hạn và điểm dừng

- Preview web trong bản release có thể không chạy được lệnh Tauri; screenshot ở đó chỉ xác nhận bố cục. Kết luận về Antigravity phải dựa vào lượt native và log tương ứng.
- Các thay đổi chưa liên quan đang có trong working tree được giữ nguyên.
- Chỉ coi lỗi treo đã giải quyết khi có lượt tái hiện trước/sau hoặc bằng chứng event tương đương; kiểm tra tĩnh không thay thế bằng chứng này.
