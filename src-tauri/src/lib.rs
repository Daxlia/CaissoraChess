//! Guscio Tauri: espone il core ai frontend tramite comandi. Nessuna logica scacchistica qui.

mod commands;
mod engine_path;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::open(dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::board_legal_moves,
            commands::board_play,
            commands::game_draw_status,
            commands::engine_start,
            commands::engine_set_strength,
            commands::engine_new_game,
            commands::engine_go,
            commands::engine_stop,
            commands::adaptive_suggest,
            commands::puzzles_overview,
            commands::puzzles_fetch_index,
            commands::puzzles_download,
            commands::puzzles_remove,
            commands::puzzles_find,
            commands::puzzles_start,
            commands::puzzles_move,
            commands::puzzles_hint,
            commands::puzzles_give_up,
            commands::puzzles_save,
            commands::openings_ensure,
            commands::openings_search,
            commands::practice_start,
            commands::practice_move,
            commands::practice_hint,
            commands::openings_saved,
            commands::openings_set_saved,
            commands::games_save,
            commands::games_list,
            commands::settings_get_all,
            commands::settings_set,
            commands::themes_import,
            commands::themes_list,
            commands::themes_remove,
            commands::theme_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CaissoraChess");
}
