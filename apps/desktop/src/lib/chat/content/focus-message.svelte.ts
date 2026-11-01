/** A request to bring one message of the open chat into view (e.g. the chat a background task came from). */
export const focusMessage = $state<{ id: string; title: string; at: number }>({ id: '', title: '', at: 0 });

export function requestFocusMessage(id: string, title = '') {
  focusMessage.id = id;
  focusMessage.title = title;
  focusMessage.at = Date.now();
}
