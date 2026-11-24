// Both homepage entry points share the existing client and its session.
export function openAccountDialog({ initialMode, user, available, sendEmail, startWechat, signOut }) {
  const dialog = document.createElement("dialog");
  dialog.className = "account-dialog";
  dialog.setAttribute("aria-labelledby", "web-account-title");
  dialog.innerHTML = `
    <div class="account-heading"><h2 id="web-account-title"></h2><button type="button" data-close aria-label="关闭">×</button></div>
    <form>
      <fieldset class="account-modes"><legend>选择账号操作</legend>
        <label><input type="radio" name="mode" value="register">注册账号</label>
        <label><input type="radio" name="mode" value="login">登录账号</label>
      </fieldset>
      <p class="account-gift">新账号注册赠 <strong>200 Bcoin</strong>，到账后 30 天有效。</p>
      <label class="account-address">邮箱地址<input type="email" name="email" required autocomplete="email" placeholder="name@example.com"></label>
      <button class="account-submit" type="submit"></button>
      <button class="account-wechat" type="button" data-wechat>微信扫码登录</button>
    </form>
    <p data-notice role="status"></p>
    <button class="account-wechat" type="button" data-logout hidden>退出登录</button>`;
  const form = dialog.querySelector("form");
  const title = dialog.querySelector("h2");
  const notice = dialog.querySelector("[data-notice]");
  const submit = form.querySelector("[type=submit]");
  const wechat = form.querySelector("[data-wechat]");
  const logout = dialog.querySelector("[data-logout]");
  const modeInputs = [...form.elements.mode];
  form.elements.mode.value = initialMode;
  let pending = false;
  function renderForm() {
    const register = form.elements.mode.value === "register";
    form.querySelector(".account-gift").hidden = !register;
    submit.textContent = register ? "发送注册链接" : "发送登录链接";
    wechat.textContent = register ? "用微信注册或登录" : "微信扫码登录";
    for (const control of [submit, wechat, form.elements.email]) control.disabled = !available || pending;
    for (const control of modeInputs) control.disabled = pending;
  }
  async function request(action, success) {
    if (pending) return;
    pending = true;
    notice.textContent = "";
    renderForm();
    try {
      await action();
      notice.textContent = success;
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      pending = false;
      renderForm();
    }
  }
  if (user) {
    form.hidden = true;
    title.textContent = "我的账号";
    notice.textContent = user;
    logout.hidden = false;
    logout.onclick = async () => {
      logout.disabled = true;
      try {
        await signOut();
        dialog.close();
      } catch (error) {
        notice.textContent = error.message;
        logout.disabled = false;
      }
    };
  } else {
    title.textContent = "登录或注册";
    if (!available) notice.textContent = "账号服务暂不可用，请稍后刷新页面。";
    renderForm();
    for (const control of modeInputs) control.onchange = () => {
      if (available) notice.textContent = "";
      renderForm();
    };
    form.onsubmit = event => {
      event.preventDefault();
      if (!available) return;
      void request(() => sendEmail(form.elements.email.value.trim(), form.elements.mode.value),
        "邮件已发送，请查收并打开验证链接。");
    };
    wechat.onclick = () => { if (available) void request(startWechat, "正在打开微信登录…"); };
  }
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
