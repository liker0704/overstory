export const NOTIFICATION_JS: string = `
(function () {
	"use strict";

	/* ===== Settings ===== */
	var SETTINGS_KEY = "overstory-notification-settings";
	var settings = { sound: false, browser: false, enabled: true };

	function loadSettings() {
		try {
			var raw = localStorage.getItem(SETTINGS_KEY);
			if (raw) {
				var parsed = JSON.parse(raw);
				if (typeof parsed.sound === "boolean") settings.sound = parsed.sound;
				if (typeof parsed.browser === "boolean") settings.browser = parsed.browser;
				if (typeof parsed.enabled === "boolean") settings.enabled = parsed.enabled;
			}
		} catch (_e) {}
	}

	function saveSettings() {
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		} catch (_e) {}
	}

	/* ===== SoundEngine ===== */
	var audioCtx = null;

	function initAudioContext() {
		if (!audioCtx) {
			try {
				audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			} catch (_e) {}
		}
	}

	function playBeep() {
		if (!audioCtx) return;
		try {
			var osc = audioCtx.createOscillator();
			var gain = audioCtx.createGain();
			osc.connect(gain);
			gain.connect(audioCtx.destination);
			osc.frequency.value = 440;
			gain.gain.value = 0.3;
			osc.start();
			osc.stop(audioCtx.currentTime + 0.1);
		} catch (_e) {}
	}

	/* ===== BroadcastChannel ===== */
	var broadcastChannel = null;

	function initBroadcastChannel() {
		if (typeof BroadcastChannel === "undefined") return;
		var sseEl = document.querySelector("[sse-connect]");
		if (!sseEl) return;
		var url = sseEl.getAttribute("sse-connect") || "";
		var match = url.match(/\\/project\\/([^\\/]+)\\/sse/);
		if (!match || !match[1]) return;
		var slug = match[1];
		try {
			broadcastChannel = new BroadcastChannel("overstory-notifications-" + slug);
			broadcastChannel.addEventListener("message", function (e) {
				if (e.data && e.data.type === "dismiss") {
					removeToastById(e.data.id);
				}
			});
		} catch (_e) {}
	}

	function broadcastDismiss(notificationId) {
		if (!broadcastChannel) return;
		try {
			broadcastChannel.postMessage({ type: "dismiss", id: notificationId });
		} catch (_e) {}
	}

	/* ===== ToastManager ===== */
	var toastContainer = null;
	var visibleToasts = [];
	var MAX_TOASTS = 5;

	function getToastContainer() {
		if (!toastContainer) {
			toastContainer = document.getElementById("toast-container");
			if (!toastContainer) {
				toastContainer = document.createElement("div");
				toastContainer.id = "toast-container";
				document.body.appendChild(toastContainer);
			}
		}
		return toastContainer;
	}

	function removeToastById(notificationId) {
		var container = getToastContainer();
		var el = container.querySelector("[data-notification-id=\\"" + notificationId + "\\"]");
		if (el) dismissToastEl(el);
	}

	function dismissToastEl(el) {
		el.classList.add("toast-exit");
		el.addEventListener("animationend", function () {
			if (el.parentNode) el.parentNode.removeChild(el);
			var idx = visibleToasts.indexOf(el);
			if (idx !== -1) visibleToasts.splice(idx, 1);
		}, { once: true });
	}

	function showToast(notification) {
		var container = getToastContainer();

		// FIFO eviction when at max
		while (visibleToasts.length >= MAX_TOASTS) {
			var oldest = visibleToasts.shift();
			if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest);
		}

		var severity = notification.severity || "low";
		var toast = document.createElement("div");
		toast.className = "toast toast-" + severity;
		if (notification.id) toast.setAttribute("data-notification-id", notification.id);

		var titleEl = document.createElement("div");
		titleEl.className = "toast-title";
		titleEl.textContent = notification.title || "";

		var bodyEl = document.createElement("div");
		bodyEl.className = "toast-body";
		bodyEl.textContent = notification.body || "";

		var closeBtn = document.createElement("button");
		closeBtn.className = "toast-close";
		closeBtn.textContent = "\u00d7";
		closeBtn.addEventListener("click", function () {
			if (notification.id) broadcastDismiss(notification.id);
			dismissToastEl(toast);
		});

		toast.appendChild(titleEl);
		toast.appendChild(bodyEl);
		toast.appendChild(closeBtn);
		container.appendChild(toast);
		visibleToasts.push(toast);

		setTimeout(function () {
			if (toast.parentNode) dismissToastEl(toast);
		}, 5000);
	}

	/* ===== BatchManager ===== */
	var batchQueue = [];
	var batchTimer = null;
	var BATCH_WINDOW_MS = 2000;
	var BATCH_THRESHOLD = 3;

	function processBatch() {
		var queue = batchQueue.slice();
		batchQueue = [];
		batchTimer = null;

		if (queue.length > BATCH_THRESHOLD) {
			showToast({ title: queue.length + " new notifications", body: "", severity: "low" });
		} else {
			for (var i = 0; i < queue.length; i++) {
				showToast(queue[i]);
			}
		}
	}

	function feedToBatch(notification) {
		batchQueue.push(notification);
		if (batchTimer) clearTimeout(batchTimer);
		batchTimer = setTimeout(processBatch, BATCH_WINDOW_MS);
	}

	/* ===== Web Notifications API ===== */
	function maybeFireWebNotification(notification) {
		if (!settings.browser) return;
		if (document.hasFocus()) return;
		if (typeof Notification === "undefined") return;
		if (Notification.permission !== "granted") return;
		var title = (notification.title || "").substring(0, 50);
		if ((notification.title || "").length > 50) title += "...";
		try {
			new Notification(title);
		} catch (_e) {}
	}

	/* ===== Settings Panel ===== */
	function initSettingsPanel() {
		var bell = document.createElement("button");
		bell.className = "notification-bell";
		bell.textContent = "\uD83D\uDD14";
		bell.setAttribute("aria-label", "Notification settings");

		var panel = document.createElement("div");
		panel.className = "notification-settings";

		function makeToggle(labelText, checked, onChange) {
			var label = document.createElement("label");
			var cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = checked;
			cb.addEventListener("change", function () {
				onChange(cb.checked);
			});
			var span = document.createElement("span");
			span.textContent = labelText;
			label.appendChild(cb);
			label.appendChild(span);
			return label;
		}

		var enabledToggle = makeToggle("Enable notifications", settings.enabled, function (val) {
			settings.enabled = val;
			saveSettings();
		});

		var browserToggle = makeToggle("Browser notifications", settings.browser, function (val) {
			settings.browser = val;
			saveSettings();
			if (val && typeof Notification !== "undefined" && Notification.permission === "default") {
				Notification.requestPermission();
			}
		});

		var soundToggle = makeToggle("Sound", settings.sound, function (val) {
			settings.sound = val;
			saveSettings();
		});

		panel.appendChild(enabledToggle);
		panel.appendChild(browserToggle);
		panel.appendChild(soundToggle);

		bell.style.position = "relative";
		bell.appendChild(panel);

		bell.addEventListener("click", function (e) {
			e.stopPropagation();
			panel.classList.toggle("open");
		});

		document.addEventListener("click", function () {
			panel.classList.remove("open");
		});

		var header = document.querySelector(".header");
		if (header) {
			header.appendChild(bell);
		} else {
			document.body.appendChild(bell);
		}
	}

	/* ===== SSE Listener ===== */
	function initSSEListener() {
		document.addEventListener("htmx:sseMessage", function (e) {
			var detail = e.detail;
			if (!detail || detail.type !== "notification") return;
			var notification;
			try {
				notification = JSON.parse(detail.data);
			} catch (_e) {
				return;
			}
			if (settings.enabled) {
				feedToBatch(notification);
			}
			if (settings.sound) {
				playBeep();
			}
			if (settings.browser && !document.hasFocus()) {
				maybeFireWebNotification(notification);
			}
		});
	}

	/* ===== Init ===== */
	function initNotifications() {
		loadSettings();
		document.addEventListener("click", initAudioContext, { once: true });
		initBroadcastChannel();
		initSettingsPanel();
		initSSEListener();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initNotifications);
	} else {
		initNotifications();
	}
})();
`;
