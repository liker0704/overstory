export const HTMX_JS: string = `
(function () {
	"use strict";

	var htmx = {
		version: "2.0.0",
		config: {
			defaultSwapStyle: "innerHTML",
			defaultSwapDelay: 0,
			defaultSettleDelay: 20,
			requestClass: "htmx-request",
		},

		/* ===== Public API ===== */
		process: function (elt) {
			_processElement(elt);
		},
		trigger: function (elt, event, detail) {
			_triggerEvent(elt, event, detail || {});
		},
		find: function (elt, selector) {
			return elt.querySelector(selector);
		},
		findAll: function (elt, selector) {
			return elt.querySelectorAll(selector);
		},
		closest: function (elt, selector) {
			return elt.closest(selector);
		},
		remove: function (elt) {
			if (elt && elt.parentNode) elt.parentNode.removeChild(elt);
		},
		addClass: function (elt, clazz) {
			if (elt) elt.classList.add(clazz);
		},
		removeClass: function (elt, clazz) {
			if (elt) elt.classList.remove(clazz);
		},
		toggleClass: function (elt, clazz) {
			if (elt) elt.classList.toggle(clazz);
		},
	};

	/* ===== Attribute helpers ===== */
	function attr(elt, name) {
		return elt.getAttribute(name) || elt.getAttribute("data-" + name);
	}

	/* ===== Event helper ===== */
	function _triggerEvent(elt, name, detail) {
		var evt = new CustomEvent(name, { bubbles: true, cancelable: true, detail: detail || {} });
		elt.dispatchEvent(evt);
	}

	/* ===== Swap ===== */
	var SWAP_STYLES = {
		innerHTML: function (target, html) {
			target.innerHTML = html;
		},
		outerHTML: function (target, html) {
			var tmp = document.createElement("template");
			tmp.innerHTML = html;
			target.parentNode && target.parentNode.replaceChild(tmp.content.firstChild || target, target);
		},
		beforebegin: function (target, html) {
			target.insertAdjacentHTML("beforebegin", html);
		},
		afterbegin: function (target, html) {
			target.insertAdjacentHTML("afterbegin", html);
		},
		beforeend: function (target, html) {
			target.insertAdjacentHTML("beforeend", html);
		},
		afterend: function (target, html) {
			target.insertAdjacentHTML("afterend", html);
		},
		none: function () {},
	};

	function _doSwap(target, html, swapStyle) {
		var fn = SWAP_STYLES[swapStyle] || SWAP_STYLES["innerHTML"];
		fn(target, html);
	}

	/* ===== Request ===== */
	function _resolveTarget(elt) {
		var targetSel = attr(elt, "hx-target");
		if (!targetSel) return elt;
		if (targetSel === "this") return elt;
		if (targetSel === "closest") return elt;
		return document.querySelector(targetSel) || elt;
	}

	function _resolveSwap(elt) {
		return attr(elt, "hx-swap") || htmx.config.defaultSwapStyle;
	}

	function _makeRequest(elt, method, url) {
		var target = _resolveTarget(elt);
		var swapStyle = _resolveSwap(elt);

		elt.classList.add(htmx.config.requestClass);
		_triggerEvent(elt, "htmx:beforeRequest", { elt: elt, target: target });

		var headers = {
			"HX-Request": "true",
			"HX-Current-URL": window.location.href,
		};
		if (target && target.id) {
			headers["HX-Target"] = target.id;
		}

		var opts = {
			method: method.toUpperCase(),
			headers: headers,
			credentials: "same-origin",
		};

		fetch(url, opts)
			.then(function (res) { return res.text(); })
			.then(function (html) {
				_doSwap(target, html, swapStyle);
				elt.classList.remove(htmx.config.requestClass);
				_triggerEvent(elt, "htmx:afterSwap", { elt: elt, target: target });
				_triggerEvent(elt, "htmx:afterRequest", { elt: elt, target: target });
				// process any new htmx elements in the swapped content
				_processElement(target);
			})
			.catch(function (err) {
				elt.classList.remove(htmx.config.requestClass);
				_triggerEvent(elt, "htmx:responseError", { elt: elt, error: err });
			});
	}

	/* ===== Binding ===== */
	var VERB_ATTRS = ["hx-get", "hx-post", "hx-put", "hx-delete", "hx-patch"];
	var VERB_MAP = { get: "get", post: "post", put: "put", delete: "delete", patch: "patch" };

	function _getVerbAndUrl(elt) {
		for (var i = 0; i < VERB_ATTRS.length; i++) {
			var a = VERB_ATTRS[i];
			var url = attr(elt, a);
			if (url !== null && url !== undefined) {
				var verb = a.replace(/^(data-)?hx-/, "");
				return { method: verb, url: url };
			}
		}
		return null;
	}

	function _bindElement(elt) {
		var info = _getVerbAndUrl(elt);
		if (!info) return;

		var triggerAttr = attr(elt, "hx-trigger");
		var triggers = triggerAttr
			? triggerAttr.split(",").map(function (t) { return t.trim(); })
			: ["click"];

		triggers.forEach(function (evtName) {
			if (!evtName) return;
			elt.addEventListener(evtName, function (e) {
				e.preventDefault();
				_makeRequest(elt, info.method, info.url);
			});
		});
	}

	function _processElement(root) {
		var allVerbSelectors = VERB_ATTRS.map(function (a) {
			return "[" + a + "],[data-" + a.replace(/^hx-/, "hx-") + "]";
		}).join(",");
		var elts = root.querySelectorAll ? root.querySelectorAll(allVerbSelectors) : [];
		elts.forEach(function (elt) { _bindElement(elt); });
		// also check root itself
		if (_getVerbAndUrl(root)) _bindElement(root);
	}

	/* ===== Init ===== */
	function init() {
		_processElement(document.body);
		_triggerEvent(document.body, "htmx:load", {});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}

	window.htmx = htmx;
})();
`;
