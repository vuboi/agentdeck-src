# Plan: fix theme dark/light switch (UI nửa sáng nửa tối)

## Triệu chứng

Đổi theme dark ↔ light (Settings > Theme hoặc `theme.toggle()`), một phần UI đổi màu, phần còn lại giữ màu theme cũ.
Lỗi giữ nguyên cho tới khi resize/di chuyển panel hoặc đóng Preview.

## Kết quả debug

### Phần đã loại trừ

- `theme.svelte.ts` áp đúng: class `dark`, `color-scheme`, token inline `!important` trên `<html>` đều khớp mode.
  Log `theme snapshot` / `theme applied` trong `%APPDATA%\dev.agentdeck.desktop*\logs\debug.log`: `htmlDark`, `token`,
  `body`, `.bg-background`, `.bg-card` luôn khớp `mode`.
- `theme ui audit` (dark mode): không có surface token nào ra màu sáng. Chỉ thấy `bg-white` của thumb switch (đúng thiết kế).
- Không có component nào override token cục bộ (`--background:`, `class="dark"`, `z-theme` con).
- Code highlight (Markdown, CodeView, DiffView), CodeEditor, xterm, ScreenshotEditor đều đã nghe `theme.dark` và vẽ lại.

### Nguyên nhân gốc: `cutHole` đóng băng màu nền của theme cũ

File: `apps/desktop/src/lib/browser/page-layer.ts` (từ commit `57d46c4`, Preview đặt dưới app).

Khi Preview có trang mở, `BrowserView.svelte:333` gọi `cutHole(stage, rect)`. Hàm này đi từ `stage` lên tới `<html>`.
Với **mọi tổ tiên có nền** (panel, layout, và `<body class="bg-background">` phủ cả cửa sổ) nó:

1. Đọc màu đã resolve: `getComputedStyle(element).backgroundColor` (ví dụ `oklch(0.21 0.006 285.885)`).
2. Lưu vào cache `holed` và **dùng lại mãi**: `holed.get(element)?.color ?? getComputedStyle(...)`.
3. Ghi inline `background-color: transparent` + 4 dải `linear-gradient(<màu cố định>)` quanh lỗ.

Khi đổi theme:

- Token đổi, nhưng các tổ tiên này vẽ bằng **màu literal đã chụp**, không phải `var(--background)` → giữ màu cũ.
- Phần tử con có `bg-*` riêng (card, sidebar, popover, input) đổi đúng → **UI nửa sáng nửa tối**.
- `cutHole` không chạy lại: key `placed` (`BrowserView.svelte:325`) chỉ gồm tab/zoom/rect, không có theme.
- Kể cả chạy lại, cache `holed` vẫn trả màu cũ (sau lần cắt đầu, computed bg đã là `transparent`, nên phải cache).
- Lỗi chỉ hết khi `cutHole(null, null)` (đóng Preview, đổi tool, tab trống, lỗi điều hướng): inline được trả lại.

Vì sao log trước không bắt được: `themeSnapshot` không ghi trạng thái hole, và các snapshot có trong log đều chụp lúc Preview không mở.

### Vấn đề phụ (không gây lỗi chính, sửa cùng đợt)

1. `src/app.html` hardcode `class="dark"` và `<meta name="theme-color" content="#0a0a0a">`.
   Người dùng mode light thấy khung tối lúc khởi động cho tới khi `theme.svelte.ts` chạy.
2. Webview Preview (`src-tauri/src/browser.rs:514`) nền trắng cố định. Trang lỗi (`browser.rs:79`) theo
   `prefers-color-scheme` của OS, không theo theme app. Dark mode → dải trắng khi resize/đang tải.
3. `logThemeUiAudit` quét **toàn bộ DOM** (`querySelectorAll('*')` + `getComputedStyle`) mỗi lần cửa sổ focus/visible.
   Tốn CPU, ghi hàng trăm dòng log. Là code debug tạm, cần gỡ sau khi fix.

## Kế hoạch sửa

### Bước 1: `page-layer.ts` - bỏ cache màu, luôn đọc màu theo theme hiện tại

- Bỏ field `color` trong `holed` (chỉ giữ `inline` gốc để trả lại).
- Trong `cutHole(stage, rect)`, với mỗi tổ tiên:
    1. Nếu đã holed: trả inline gốc trước (`BACKGROUND.forEach(... = inline[i])`).
    2. Đọc `getComputedStyle(element).backgroundColor` (giờ là màu thật của theme hiện tại).
    3. Cắt lỗ lại bằng màu đó.
- Tất cả chạy đồng bộ trong một task → trình duyệt không paint frame trung gian, không nháy.
- Số tổ tiên ít (~5–10), chỉ chạy khi rect/theme đổi → chi phí style recalc không đáng kể.

### Bước 2: `BrowserView.svelte` - cắt lại lỗ khi theme đổi

- Thêm `theme.settledKey` vào key `placed` (dòng 325), hoặc một `$effect` riêng:

    ```ts
    $effect(() => {
        void theme.settledKey;
        untrack(() => {
            placed = '';
            void sync();
        });
    });
    ```

- Dùng `settledKey` (không dùng `theme.dark`): `settledKey` được set **sau** khi class + token đã áp lên `<html>`
  (`theme.svelte.ts:299`), nên `getComputedStyle` đọc ra màu mới.
- Nếu `sync()` bất đồng bộ làm trễ 1 frame: gọi thẳng `cutHole(stage, lastRect)` đồng bộ trong effect, rồi mới `sync()`.
  Cần lưu `lastRect` khi `placePage` cắt lỗ.

### Bước 3: chẩn đoán gọn hơn trong `theme.svelte.ts`

- Thêm vào `themeSnapshot`: số phần tử đang holed (export `holeCount()` từ `page-layer.ts`), và `body` inline `background-image` có hay không.
- Gỡ `logThemeUiAudit` cùng listener `focus` / `visibilitychange` (chỉ giữ snapshot `before apply` / `applied` / `next frame`).
- Giữ `MutationObserver` "root drift" (rẻ, có ích).

### Bước 4: khởi động đúng theme (vấn đề phụ 1)

- `app.html`: bỏ `class="dark"` cứng. Thêm script inline nhỏ trong `<head>` đọc `localStorage['agentdeck.theme']`,
  set class `dark` + `style.colorScheme` + nền tạm (`#fff` / màu 900 của neutral) trước khi CSS paint.
- CSP là `script-src 'self'`. Tauri tự thêm hash cho inline script khi build, nhưng dev server có thể bị chặn.
  An toàn nhất: đặt script trong `static/theme-boot.js`, load bằng `<script src>` đồng bộ.
- Cập nhật `<meta name="theme-color">` trong effect của `theme.svelte.ts`.

### Bước 5: Preview webview theo theme app (vấn đề phụ 2, ưu tiên thấp)

- `browser.rs`: nhận tham số `dark: bool` khi tạo/hiện webview; `background_color` = trắng hoặc màu nền tối.
- Trang lỗi: render với `color-scheme` theo app thay vì `@media (prefers-color-scheme)`.
- Không ép trang web ngoài theo theme app (trang tự quyết `prefers-color-scheme`).

## Kiểm tra

### Tái hiện trước khi sửa (để chắc nguyên nhân)

1. `pnpm dev` (cần `~/.cargo/bin` trong PATH).
2. Mở Preview, vào một URL bất kỳ (ví dụ `http://127.0.0.1:1430`).
3. Settings > Theme: dark → light.
4. Kỳ vọng thấy lỗi: nền body/panel quanh Preview vẫn tối, card/sidebar đã sáng.
5. DevTools console: `document.body.style.backgroundImage` chứa `linear-gradient(oklch(0.21 ...` (màu tối).
6. Đối chứng: đóng Preview rồi đổi theme → không lỗi.

### Sau khi sửa

- Lặp lại bước 1–3 với Preview mở: toàn bộ UI đổi màu trong một frame.
- `document.body.style.backgroundImage` chứa màu nền của theme mới.
- Đổi qua lại dark/light/system nhanh 10 lần, đổi neutral (zinc/stone/slate): không còn vệt màu cũ.
- Mở modal/menu đè lên Preview (page xuống dưới app) sau khi đổi theme: viền quanh lỗ đúng màu.
- Resize cửa sổ, kéo panel: lỗ vẫn đúng vị trí, đúng màu.
- Khởi động app ở mode light: không có frame tối.
- Terminal, code block, diff, editor đổi màu như trước.

### DoD

```bash
cd apps/desktop && pnpm check
```

```bash
cd apps/desktop && pnpm test
```

```bash
cargo clippy --workspace -- -D warnings
```

(Chỉ cần clippy nếu làm Bước 5.)

## File đụng tới

| File                                                             | Bước |
| ---------------------------------------------------------------- | ---- |
| `apps/desktop/src/lib/browser/page-layer.ts`                     | 1, 3 |
| `apps/desktop/src/lib/components/browser/BrowserView.svelte`     | 2    |
| `apps/desktop/src/lib/app/ui/theme.svelte.ts`                    | 3, 4 |
| `apps/desktop/src/app.html`, `apps/desktop/static/theme-boot.js` | 4    |
| `apps/desktop/src-tauri/src/browser.rs`                          | 5    |
