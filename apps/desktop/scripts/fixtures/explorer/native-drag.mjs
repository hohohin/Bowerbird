// Generate drag data in Chromium itself. Playwright's mouse drag helper installs
// a late window listener, which production stopImmediatePropagation blocks.
export async function startBrowserDrag(page, x, y) {
  const session = await page.context().newCDPSession(page);
  let timeout;
  try {
    await session.send("Input.setInterceptDrags", { enabled: true });
    const intercepted = new Promise((resolve, reject) => {
      session.once("Input.dragIntercepted", resolve);
      timeout = setTimeout(() => reject(new Error("Browser did not start the image drag")), 5000);
    });
    // Register the rejection handler before dispatching input.
    intercepted.catch(() => {});
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 30, y: y + 30, button: "left", buttons: 1 });
    const { data } = await intercepted;
    return { session, data };
  } catch (error) { await session.detach(); throw error; }
  finally { clearTimeout(timeout); }
}

export async function finishBrowserDrag(session, data, x, y) {
  for (const type of ["dragEnter", "dragOver", "drop"]) await session.send("Input.dispatchDragEvent", { type, data, x, y });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await session.detach();
}
