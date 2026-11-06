use tauri::AppHandle;

/// Saves Markdown text where the user picks and answers the chosen path, or `None` when the dialog was cancelled.
#[tauri::command]
pub async fn markdown_save(
    app: AppHandle,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let destination = app
            .dialog()
            .file()
            .set_title("Save Markdown file")
            .set_file_name(name)
            .add_filter("Markdown", &["md"])
            .blocking_save_file();
        let Some(destination) = destination else {
            return Ok(None);
        };
        let destination = destination.into_path().map_err(|error| error.to_string())?;
        std::fs::write(&destination, text).map_err(|error| error.to_string())?;
        Ok(Some(destination.display().to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}
