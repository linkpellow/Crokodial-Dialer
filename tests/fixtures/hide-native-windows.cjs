/** Keep fixture windows off the desktop; Playwright still drives their renderer
 * through CDP. This affects only the isolated Electron test process. A one-time
 * hide is insufficient because authenticated DialerEngine initialization invokes
 * window-show, and reload/ready-to-show can also restore native focus. */
async function hideNativeWindows(electronApp) {
  await electronApp.evaluate(({ app, BrowserWindow }) => {
    const hide = window => {
      window.setFocusable(false);
      window.hide();
      window.show = () => {};
      window.showInactive = () => {};
      window.focus = () => {};
      window.on('show', () => window.hide());
    };
    for (const window of BrowserWindow.getAllWindows()) hide(window);
    app.on('browser-window-created', (_event, window) => hide(window));
  });
}
module.exports = { hideNativeWindows };
