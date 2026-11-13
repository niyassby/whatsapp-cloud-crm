/**
 * The embed script: `<script src="<api>/webchat/widget.js" data-key="wc_..." async></script>`.
 * It adds a launcher button and an iframe of the chat page, which runs on the app's own origin,
 * so the host page's styles and scripts cannot reach the conversation.
 */
export function widgetScript(webUrl: string): string {
  const base = JSON.stringify(webUrl.replace(/\/$/, ''));
  return `(function () {
  var script = document.currentScript;
  var key = script && script.getAttribute('data-key');
  if (!key || window.__wacrmChat) return;
  window.__wacrmChat = true;
  var color = (script.getAttribute('data-color') || '#16a34a');
  var frame = document.createElement('iframe');
  frame.title = 'Chat';
  frame.src = ${base} + '/widget/' + encodeURIComponent(key) + '?origin=' + encodeURIComponent(location.origin);
  frame.setAttribute('allow', 'clipboard-write');
  frame.style.cssText = 'position:fixed;bottom:88px;right:20px;width:min(380px,calc(100vw - 40px));height:min(560px,calc(100vh - 120px));border:0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:2147483646;display:none;background:#fff';
  var button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Open chat');
  button.setAttribute('aria-expanded', 'false');
  button.style.cssText = 'position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.2);color:#fff;background:' + color;
  button.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  button.addEventListener('click', function () {
    var open = frame.style.display === 'none';
    frame.style.display = open ? 'block' : 'none';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  });
  document.body.appendChild(frame);
  document.body.appendChild(button);
})();
`;
}
