// Shared DOM runtime for the application and embedded Pinterest. No React or IPC.
(() => {
    const LAYER = "[data-industrial-scrollbar-layer]";
    const ROOT_CLASS = "industrial-overlay-scrollbars";
    let sequence = 0;
    function scrollAxes(view) {
        const style = getComputedStyle(view);
        if (view === document.scrollingElement) {
            const body = getComputedStyle(document.body);
            return { x: !/hidden|clip/.test(style.overflowX === "visible" ? body.overflowX : style.overflowX),
                y: !/hidden|clip/.test(style.overflowY === "visible" ? body.overflowY : style.overflowY) };
        }
        return { x: /auto|scroll/.test(style.overflowX), y: /auto|scroll/.test(style.overflowY) };
    }
    function viewportBounds(view) {
        if (view === document.scrollingElement) return { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const rect = view.getBoundingClientRect();
        const sx = rect.width / (view.offsetWidth || 1), sy = rect.height / (view.offsetHeight || 1);
        const left = rect.left + view.clientLeft * sx, top = rect.top + view.clientTop * sy;
        return { left, top, right: left + view.clientWidth * sx, bottom: top + view.clientHeight * sy };
    }
    function clipBounds(bounds, node, isViewport) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility !== "visible")
            return false;
        if (isViewport)
            return true;
        const clip = viewportBounds(node);
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
            bounds.left = Math.max(bounds.left, clip.left);
            bounds.right = Math.min(bounds.right, clip.right);
        }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
            bounds.top = Math.max(bounds.top, clip.top);
            bounds.bottom = Math.min(bounds.bottom, clip.bottom);
        }
        return true;
    }
    function visibleBounds(view) {
        if (!view.isConnected || view.closest('[inert], [aria-hidden="true"]'))
            return null;
        const bounds = viewportBounds(view);
        bounds.left = Math.max(0, bounds.left);
        bounds.top = Math.max(0, bounds.top);
        bounds.right = Math.min(innerWidth, bounds.right);
        bounds.bottom = Math.min(innerHeight, bounds.bottom);
        for (let node = view; node; node = node.parentElement) {
            if (!clipBounds(bounds, node, node === view))
                return null;
        }
        return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
    }
    function position(view, axis) {
        if (axis === "y")
            return view.scrollTop;
        return getComputedStyle(view).direction === "rtl" ? -view.scrollLeft : view.scrollLeft;
    }
    function setPosition(view, axis, value) {
        const maximum = axis === "y" ? view.scrollHeight - view.clientHeight : view.scrollWidth - view.clientWidth;
        const next = Math.max(0, Math.min(maximum, value));
        if (axis === "y")
            view.scrollTop = next;
        else
            view.scrollLeft = getComputedStyle(view).direction === "rtl" ? -next : next;
    }
    function layer(tag, className) {
        const node = document.createElement(tag);
        node.className = className;
        node.dataset.industrialScrollbarLayer = "";
        return node;
    }
    function applyStyle(node, value) {
        if (node.style.cssText !== value)
            node.style.cssText = value;
    }
    function wheel(view, event) {
        if (event.ctrlKey || event.metaKey)
            return;
        event.preventDefault();
        event.stopPropagation();
        // Existing virtual-list wheel handlers keep authority over logical scaling.
        const forwarded = new WheelEvent("wheel", { bubbles: true, cancelable: true,
            deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
            shiftKey: event.shiftKey, altKey: event.altKey, clientX: event.clientX, clientY: event.clientY });
        if (!view.dispatchEvent(forwarded))
            return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1;
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        setPosition(view, "x", position(view, "x") + dx * unit);
        if (!event.shiftKey)
            setPosition(view, "y", view.scrollTop + event.deltaY * unit);
    }
    function railGeometry(view, axis, bounds, otherAxis) {
        const horizontal = axis === "x";
        const extent = horizontal ? view.clientWidth : view.clientHeight;
        const total = horizontal ? view.scrollWidth : view.scrollHeight;
        const max = Math.max(0, total - extent);
        const length = (horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top) - 8 - (otherAxis ? 12 : 0);
        const thumb = Math.min(length, Math.max(28, length * extent / total));
        const left = horizontal ? bounds.left + 4 : bounds.right - 14;
        const top = horizontal ? bounds.bottom - 14 : bounds.top + 4;
        return { start: horizontal ? left : top, left, top, length, thumb, travel: length - thumb, max };
    }
    function scrollbarLabel(view, axis) {
        const label = view.dataset.overlayScrollLabel;
        if (label)
            return axis === "y" ? label : `${label}（横向）`;
        return `${view.getAttribute("aria-label") || "内容"}${axis === "y" ? "纵向" : "横向"}滚动条`;
    }
    class Rail {
        view;
        axis;
        lock;
        node = layer("button", "industrial-scrollbar");
        thumb = layer("span", "industrial-scrollbar-thumb");
        geometry = { start: 0, length: 0, thumb: 0, travel: 0, max: 0 };
        drag = null;
        events = new AbortController();
        constructor(view, axis, lock) {
            this.view = view;
            this.axis = axis;
            this.lock = lock;
            const node = this.node;
            node.type = "button";
            node.tabIndex = -1;
            node.dataset.axis = axis;
            node.setAttribute("role", "scrollbar");
            node.setAttribute("aria-controls", view.id);
            node.setAttribute("aria-orientation", axis === "y" ? "vertical" : "horizontal");
            node.setAttribute("aria-label", scrollbarLabel(view, axis));
            node.setAttribute("aria-valuemin", "0");
            node.append(this.thumb);
            const options = { signal: this.events.signal };
            node.addEventListener("wheel", event => wheel(view, event), { ...options, passive: false });
            node.addEventListener("keydown", event => this.key(event), options);
            node.addEventListener("pointerdown", event => this.press(event), options);
            node.addEventListener("pointermove", event => this.move(event), options);
            node.addEventListener("pointerup", event => { if (node.hasPointerCapture(event.pointerId))
                node.releasePointerCapture(event.pointerId); this.release(); }, options);
            node.addEventListener("pointercancel", () => this.release(), options);
            node.addEventListener("lostpointercapture", () => this.release(), options);
            node.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); }, options);
        }
        coordinate(event) { return this.axis === "x" ? event.clientX : event.clientY; }
        press(event) {
            if (event.button !== 0 || this.geometry.travel <= 0)
                return;
            event.preventDefault();
            event.stopPropagation();
            this.node.focus({ preventScroll: true });
            const coordinate = this.coordinate(event);
            if (event.target !== this.thumb)
                setPosition(this.view, this.axis, (coordinate - this.geometry.start - this.geometry.thumb / 2) / this.geometry.travel * this.geometry.max);
            this.drag = { pointer: event.pointerId, coordinate, value: position(this.view, this.axis) };
            this.node.setPointerCapture(event.pointerId);
            this.node.dataset.dragging = "true";
            this.lock(true);
        }
        move(event) {
            if (!this.drag || this.geometry.travel <= 0)
                return;
            event.stopPropagation();
            setPosition(this.view, this.axis, this.drag.value + (this.coordinate(event) - this.drag.coordinate) / this.geometry.travel * this.geometry.max);
        }
        release() { this.drag = null; delete this.node.dataset.dragging; this.lock(false); }
        key(event) {
            const size = this.axis === "x" ? this.view.clientWidth : this.view.clientHeight;
            const deltas = this.axis === "x" ? { ArrowLeft: -40, ArrowRight: 40 } : { ArrowUp: -40, ArrowDown: 40 };
            const values = { Home: 0, End: this.geometry.max, PageUp: position(this.view, this.axis) - size,
                PageDown: position(this.view, this.axis) + size };
            const value = event.key in deltas ? position(this.view, this.axis) + deltas[event.key] : values[event.key];
            if (value == null)
                return;
            event.preventDefault();
            event.stopPropagation();
            setPosition(this.view, this.axis, value);
        }
        paint(bounds, origin, otherAxis) {
            const horizontal = this.axis === "x";
            const geometry = railGeometry(this.view, this.axis, bounds, otherAxis);
            const { max, length, thumb, travel, left, top } = geometry;
            this.node.hidden = max <= 1 || length < 24;
            if (this.node.hidden)
                return;
            const sx = origin.width / 100, sy = origin.height / 100;
            if (!sx || !sy)
                return;
            const value = Math.max(0, Math.min(max, position(this.view, this.axis)));
            this.geometry = geometry;
            applyStyle(this.node, `left: ${(left - origin.left) / sx}px; top: ${(top - origin.top) / sy}px; width: ${(horizontal ? length : 12) / sx}px; height: ${(horizontal ? 12 : length) / sy}px;`);
            const offset = value / max * travel;
            applyStyle(this.thumb, horizontal
                ? `left: ${offset / sx}px; top: ${4 / sy}px; width: ${thumb / sx}px; height: ${4 / sy}px;`
                : `top: ${offset / sy}px; left: ${4 / sx}px; height: ${thumb / sy}px; width: ${4 / sx}px;`);
            this.node.setAttribute("aria-valuemax", String(max));
            this.node.setAttribute("aria-valuenow", String(Math.round(value)));
        }
        destroy() {
            if (this.drag)
                this.release();
            this.events.abort();
            this.node.remove();
        }
    }
    class Viewport {
        view;
        probe = layer("span", "industrial-scrollbar-origin");
        rails;
        originalId;
        resize;
        changes;
        timer = 0;
        constructor(view, lock, wake) {
            this.view = view;
            this.originalId = view.id;
            if (!view.id)
                view.id = `industrial-scroll-viewport-${++sequence}`;
            // Editor-owned DOM is never touched, including descendants of rich editors.
            const protectedRoot = view.closest('textarea, button, [contenteditable="true"]');
            const host = view === document.scrollingElement ? document.body : protectedRoot?.parentElement ?? view;
            this.probe.setAttribute("aria-hidden", "true");
            host.append(this.probe);
            this.rails = [new Rail(view, "x", lock), new Rail(view, "y", lock)];
            this.rails.forEach(rail => host.append(rail.node));
            this.resize = new ResizeObserver(wake);
            this.observeContent();
            this.changes = new MutationObserver(records => {
                if (!records.some(contentChanged))
                    return;
                this.observeContent();
                wake();
            });
            this.changes.observe(view, { subtree: true, childList: true, characterData: true, attributes: true });
        }
        observeContent() {
            this.resize.disconnect();
            this.resize.observe(this.view);
            for (const child of this.view.children)
                if (!child.matches(LAYER))
                    this.resize.observe(child);
        }
        reveal() {
            clearTimeout(this.timer);
            this.rails.forEach(rail => { rail.node.dataset.visible = "true"; rail.node.tabIndex = 0; });
            this.timer = window.setTimeout(() => this.rails.forEach(rail => { delete rail.node.dataset.visible; rail.node.tabIndex = -1; }), 800);
        }
        paint() {
            const bounds = visibleBounds(this.view), axes = scrollAxes(this.view);
            const overflow = { x: axes.x && this.view.scrollWidth > this.view.clientWidth + 1, y: axes.y && this.view.scrollHeight > this.view.clientHeight + 1 };
            const origin = this.probe.getBoundingClientRect();
            for (const rail of this.rails) {
                if (!bounds || !overflow[rail.axis])
                    rail.node.hidden = true;
                else
                    rail.paint(bounds, origin, overflow[rail.axis === "x" ? "y" : "x"]);
            }
        }
        destroy() {
            this.resize.disconnect();
            this.changes.disconnect();
            this.rails.forEach(rail => rail.destroy());
            clearTimeout(this.timer);
            this.probe.remove();
            if (!this.originalId)
                this.view.removeAttribute("id");
        }
    }
    function contentChanged(record) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        if (element?.closest(LAYER))
            return false;
        if (record.type !== "childList")
            return true;
        return [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.matches(LAYER)));
    }
    class ActiveScrollbars {
        views = new Map();
        owners = new WeakMap();
        ancestorsObserved = new Set();
        events = new AbortController();
        changes = new MutationObserver(records => { if (records.some(contentChanged))
            this.wake(); });
        alreadyEnabled = document.documentElement.classList.contains(ROOT_CLASS);
        current = null;
        scrolling = null;
        locked = false;
        frame = 0;
        disposed = false;
        motionUntil = 0;
        constructor() {
            const options = { capture: true, signal: this.events.signal };
            for (const name of ["pointermove", "focusin", "scroll", "input"])
                document.addEventListener(name, event => this.activate(event), options);
            for (const name of ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"]) {
                document.addEventListener(name, event => this.motion(event), options);
            }
            window.addEventListener("resize", () => this.wake(), options);
            document.documentElement.classList.add(ROOT_CLASS);
            this.current = this.targetElement(document.activeElement);
            this.wake();
        }
        targetElement(target) {
            if (target === document) return document.scrollingElement;
            const node = target instanceof HTMLElement ? target : null;
            return node ? this.owners.get(node.closest(".industrial-scrollbar") ?? node) ?? node : null;
        }
        scrollAncestors(start, result) {
            if (start?.closest("[data-overlay-scrollbars-suspended]"))
                return;
            for (let node = start; node; node = node.parentElement) {
                if (node.matches(LAYER))
                    continue;
                const axes = scrollAxes(node);
                if ((axes.x || axes.y) && visibleBounds(node))
                    result.add(node);
            }
        }
        reconcile() {
            const wanted = new Set();
            this.scrollAncestors(this.current, wanted);
            this.scrollAncestors(this.targetElement(document.activeElement), wanted);
            for (const [node, viewport] of this.views)
                if (!wanted.has(node)) {
                    viewport.destroy();
                    this.views.delete(node);
                }
            for (const node of wanted)
                if (!this.views.has(node))
                    this.addViewport(node);
            this.observeAncestors();
        }
        addViewport(node) {
            const viewport = new Viewport(node, value => {
                this.locked = value;
                if (!value)
                    viewport.reveal();
                this.wake();
            }, () => this.wake());
            this.views.set(node, viewport);
            viewport.rails.forEach(rail => this.owners.set(rail.node, node));
        }
        observeAncestors() {
            const next = new Set();
            for (const start of [this.current, this.targetElement(document.activeElement)]) {
                for (let node = start; node; node = node.parentElement)
                    if (!node.matches(LAYER))
                        next.add(node);
            }
            if (next.size === this.ancestorsObserved.size && [...next].every(node => this.ancestorsObserved.has(node)))
                return;
            this.changes.disconnect();
            this.ancestorsObserved.clear();
            for (const node of next) {
                this.ancestorsObserved.add(node);
                this.changes.observe(node, { childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "inert", "aria-hidden", "open", "data-overlay-scrollbars-suspended"] });
            }
        }
        paint() {
            this.frame = 0;
            if (this.disposed)
                return;
            this.reconcile();
            this.views.forEach(viewport => viewport.paint());
            if (this.scrolling) {
                this.views.get(this.scrolling)?.reveal();
                this.scrolling = null;
            }
            // Only a bounded active CSS transition needs frame-by-frame sampling.
            if (this.views.size && performance.now() < this.motionUntil)
                this.frame = requestAnimationFrame(() => this.paint());
        }
        wake() { if (!this.frame && !this.disposed)
            this.frame = requestAnimationFrame(() => this.paint()); }
        activate(event) {
            if (this.locked) {
                if (event.type === "scroll")
                    this.wake();
                return;
            }
            const next = this.targetElement(event.target);
            if (event.type === "pointermove" && next === this.current)
                return;
            if (next?.closest(LAYER))
                return;
            this.current = next;
            if (event.type === "scroll")
                this.scrolling = next;
            this.wake();
        }
        motion(event) {
            if (!(event.target instanceof HTMLElement) || !this.ancestorsObserved.has(event.target))
                return;
            this.motionUntil = event.type.endsWith("end") || event.type.endsWith("cancel") ? 0 : performance.now() + 1200;
            this.wake();
        }
        destroy() {
            this.disposed = true;
            cancelAnimationFrame(this.frame);
            this.events.abort();
            this.changes.disconnect();
            this.views.forEach(viewport => viewport.destroy());
            if (!this.alreadyEnabled)
                document.documentElement.classList.remove(ROOT_CLASS);
        }
    }
    let manager = null;
    let owners = 0;
    /** The application root and isolated scroll-area previews share one manager. */
    function enableOverlayScrollbars() {
        if (!manager)
            manager = new ActiveScrollbars();
        owners++;
        let active = true;
        return () => {
            if (!active)
                return;
            active = false;
            if (--owners > 0)
                return;
            manager?.destroy();
            manager = null;
        };
    }
    window.enableBowerbirdOverlayScrollbars = enableOverlayScrollbars;
})();
