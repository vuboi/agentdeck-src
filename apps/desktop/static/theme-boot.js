// Runs before the app's styles and scripts, so the first frame already has the saved theme.
// Keep the storage key and the mode names in step with src/lib/app/ui/theme.svelte.ts.
(function () {
    var dark = true;
    try {
        var saved = JSON.parse(localStorage.getItem('agentdeck.theme') || '{}');
        if (saved.mode === 'light') dark = false;
        else if (saved.mode === 'system')
            dark = matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
        // Nothing saved, or storage blocked: the app's default theme, dark.
    }
    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0a0a0a' : '#ffffff');
})();
