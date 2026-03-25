export const CLIENT_JS: string = `
(function () {
	"use strict";

	/* ===== Nav Highlighting ===== */
	function initNav() {
		var path = window.location.pathname;
		var items = document.querySelectorAll(".nav-item");
		items.forEach(function (el) {
			var href = el.getAttribute("href");
			if (!href) return;
			var isActive = href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
			if (isActive) el.classList.add("nav-active");
		});
	}

	/* ===== Relative Time ===== */
	function relativeTime(dateStr) {
		var now = Date.now();
		var then = new Date(dateStr).getTime();
		if (isNaN(then)) return dateStr;
		var diff = Math.floor((now - then) / 1000);
		if (diff < 5) return "just now";
		if (diff < 60) return diff + "s ago";
		var mins = Math.floor(diff / 60);
		if (mins < 60) return mins + "m ago";
		var hours = Math.floor(mins / 60);
		if (hours < 24) return hours + "h ago";
		var days = Math.floor(hours / 24);
		return days + "d ago";
	}

	function updateRelativeTimes() {
		var els = document.querySelectorAll("time[datetime]");
		els.forEach(function (el) {
			var dt = el.getAttribute("datetime");
			if (dt) el.textContent = relativeTime(dt);
		});
	}

	/* ===== SSE ===== */
	// SSE connection handled by htmx sse extension via sse-connect attributes.
	// No manual EventSource needed.

	/* ===== Copy to Clipboard ===== */
	function initCopy() {
		document.addEventListener("click", function (e) {
			var target = e.target;
			if (!target || !target.classList || !target.classList.contains("copy-btn")) return;
			var text = target.getAttribute("data-copy") || target.textContent || "";
			if (!navigator.clipboard) return;
			navigator.clipboard.writeText(text.trim()).then(function () {
				var original = target.textContent;
				target.textContent = "Copied!";
				setTimeout(function () {
					target.textContent = original;
				}, 1500);
			});
		});
	}

	/* ===== Init ===== */
	function init() {
		initNav();
		updateRelativeTimes();
		setInterval(updateRelativeTimes, 15000);
		initCopy();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
`;
