// Only a visual overlay: no page data, credentials, or application IPC are exposed.
(() => {
  const id = "bowerbird-onboarding-shade";
  const existing = document.getElementById(id);
  if (!__BOWERBIRD_DIMMED__) { existing?.remove(); return; }
  if (existing || !document.documentElement) return;
  const shade = document.createElement("div");
  shade.id = id;
  shade.setAttribute("aria-hidden", "true");
  shade.style.cssText = "position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;background:rgba(0,0,0,.56)!important;pointer-events:none!important;z-index:2147483647!important;";
  const style = document.createElement("style");
  style.textContent = `#${id}::backdrop{background:transparent!important;pointer-events:none!important}`;
  shade.append(style);
  // Use the webpage's top layer so its login dialog is dimmed as well.
  if (typeof shade.showPopover === "function") shade.setAttribute("popover", "manual");
  document.documentElement.append(shade);
  if (shade.hasAttribute("popover")) shade.showPopover();
})();
