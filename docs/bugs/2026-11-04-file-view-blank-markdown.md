# Bug — File view trắng, không xem được file .md (Preview thì xem được)

- Ngày: 2026-11-04
- Chat / provider: `claude:cbf2d018-147e-46cb-a5fe-48a89d8c3213` (command-code), project msg-new-template
- File thử: `E:/WORK/PROJECTS/agentdeck/docs/bugs/2026-11-04-ask-card-not-opened.md` (7.9 KB, 137 dòng)
- Ảnh chụp: `C:/Users/boi.vn/.agentdeck/attachments/image-18e4ceabdbaeacc4.webp`
- Trạng thái: **CHƯA chốt được nguyên nhân** — cần tái hiện có log (xem mục 4)

---

## 1. Triệu chứng

Đọc từ ảnh chụp:

- Panel Files có 2 tab file đang mở; tab đang chọn là file `.md` này (`2026-11-04-ask-card-n…`).
- Vùng nội dung: chỉ có gutter số dòng 1..20 màu xám, **toàn bộ phần chữ trống**; không thấy thanh công cụ (`h-10`) lẫn footer (đường dẫn · số dòng · dung lượng) mà FileView vẫn vẽ khi file đã đọc xong.
- User nói: bật Preview (nút con mắt "Preview the rendered Markdown") thì xem được, còn ở File view thì lỗi.

---

## 2. Đã kiểm chứng — những thứ KHÔNG phải nguyên nhân

- File hợp lệ: 7924 bytes, không BOM, 137 dòng, LF là chính. Có **trộn CRLF/LF** (5 CRLF lẫn trong 137 LF) nhưng `splitFileText()` đã chuẩn hoá `\r\n?` thành `\n` (file-edit.ts:7-13) nên không phải do dòng kết thúc.
- Không vượt giới hạn: `MAX_EDIT_BYTES` = 1 MB (file-edit.ts:22), `file_read` chặn ở 2 MB (lib.rs:1219) — file 7.9 KB nên không rơi vào nhánh read-only.
- `errors.log` **không** có bản ghi nào về việc mở file này: không có dòng "file is outside the project folder" cho đường dẫn `docs/bugs/*.md`.

---

## 3. Nghi vấn (xếp theo khả năng)

### N1 — `root` của tab không phủ file, nên `file_read` từ chối

`apps/desktop/src-tauri/src/lib.rs:1215-1240` — `file_read(root, path)` canonicalize cả hai rồi:

```
if !path.starts_with(&root) {
    return Err("file is outside the project folder".to_string());
}
```

Link trong chat đọc được vì `Markdown.svelte:708-711` truyền `fileRootOf(path, projectRoot)` — file ngoài project thì root = thư mục chứa chính nó:

```
// The viewer reads only inside a root folder: the project when the file is in it, else the file's own folder.
function openFile(path: string, projectRoot: string) {
    openInViewer(path, fileRootOf(path, projectRoot));
}
```

Nhưng tab còn có thể được mở/khôi phục bằng đường khác (mở lại tab đã lưu, "Open in a main tab" ở FileViewer.svelte:155, File Explorer) — nếu lúc đó `root` là project root của chat (`E:\WORK\PROJECTS\msg-new-template`) thì `file_read` trả `file is outside the project folder` và FileView hiện panel "Can't open …" (FileView.svelte:727-784).

Ghi chú: workspace của chat này bị khoá về `E:\WORK\PROJECTS\msg-new-template` — `errors.log` đã ghi lại đúng cảnh báo đó cho chat này (2 dòng lúc 09:30:42), nên giả thuyết này khớp bối cảnh.

### N2 — CodeEditor dựng gutter nhưng không vẽ chữ

`FileView.svelte:952-969` render `<CodeEditor doc={startDoc} …>`. `startDoc` lấy từ `adopt()` (FileView.svelte:209-226) và ưu tiên draft còn lưu (FileView.svelte:221-226):

```
const kept = drafts.get(file.id);
if (kept) return adopt(kept.disk, kept);
```

Nếu `drafts` còn một draft cũ với `text: ''` thì editor mở rỗng, dù file trên đĩa có nội dung.

### N3 — Ảnh chụp có thể đang ở nhánh "đang đọc file"

Nhánh `{:else}` của FileView (FileView.svelte:974-987) vẽ thanh trống `h-10` + `LoadingBar` và footer chỉ có đường dẫn — **không có gutter số dòng**. Ảnh lại có gutter 1..20 nên khó khớp; cần chụp lại toàn panel để biết nhánh nào đang render.

---

## 4. Cách xác nhận

1. Settings > Debug (đang bật mặc định) -> mở lại đúng file đó -> lọc `logs/debug.log` và `logs/errors.log` theo tên file để xem `root` nào được dùng và có lỗi `file_read` hay không.
2. Mở một file `.md` **nằm trong** project đang chat (msg-new-template):
    - hiện bình thường -> nghi vấn N1 (root / file ngoài project);
    - cũng trắng -> nghi vấn N2 (CodeEditor).
3. Chụp lại **toàn bộ** panel Files (thấy cả thanh công cụ trên và footer dưới) để biết nhánh template nào đang render.

---

## 5. Phụ lục — vị trí code

| File                                                    | Dòng                                                    | Vai trò                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/lib.rs`                     | 1215-1240 `file_read`                                   | Chặn đọc ngoài `root`; giới hạn 2 MB                                            |
| `apps/desktop/src/lib/components/ui/Markdown.svelte`    | 708-711 `openFile`                                      | Chọn root: project root nếu file nằm trong project, ngược lại thư mục chứa file |
| `apps/desktop/src/lib/files/file-viewer.svelte.ts`      | 51-70 `openInViewer`                                    | Mở/focus file trong panel Files, nhận `root`                                    |
| `apps/desktop/src/lib/app/ui/content-tabs.svelte.ts`    | 188-206 `openFileTab`                                   | Mở file thành tab chính, giữ nguyên `root` (`view` file/changes)                |
| `apps/desktop/src/lib/components/files/FileView.svelte` | 727-784 lỗi; 952-969 CodeEditor; 974-987 nhánh đang đọc | Nơi render file, editor và panel lỗi                                            |
| `apps/desktop/src/lib/files/file-edit.ts`               | 7-22                                                    | `splitFileText` (chuẩn hoá CRLF) và `MAX_EDIT_BYTES`                            |
| `apps/desktop/src/lib/files/paths.ts`                   | `fileRootOf`, `resolveInProject`                        | Quyết định root cho file ngoài project                                          |
