import {lensFixture} from './page.mjs';

// Public Pinterest shell: fixed #VerticalNavContent, inline content padding and
// an expanded native sidebar. Site data/actions remain synthetic.
export function chromeFixture() {
  return lensFixture().replace('<header id="site-header">', `<nav id="VerticalNavContent" style="position:fixed;top:0;left:0;width:72px;height:100vh;background:#fff;border-right:1px solid #ddd;z-index:5"><div style="padding:16px 12px"><div data-test-id="vertical-nav-icon"><button style="width:48px;height:48px" onclick="window.navClicks=(window.navClicks||0)+1;document.querySelector('#expanded-sidebar').hidden=false;document.querySelector('#page-inset').style.paddingLeft='312px'" aria-label="消息">☷</button></div></div></nav><aside id="expanded-sidebar" data-test-id="sidebar-container" hidden style="position:fixed;top:0;width:240px;height:100vh;margin-left:72px;background:#eee;z-index:4">Native messages</aside><div class="appContent"><div id="page-inset" style="padding-left:72px"><div class="mainContainer"><header id="site-header">`)
    .replace('</body>', '<section id="nested-scroll" style="width:220px;height:120px;overflow:auto;border:1px solid #aaa"><div style="width:480px;height:600px">Nested page content</div></section></div></div></div></body>');
}
