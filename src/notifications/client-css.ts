export const NOTIFICATION_CSS: string = `
/* ===== Toast Container ===== */
#toast-container {
	position: fixed;
	bottom: 20px;
	right: 20px;
	z-index: 9999;
	display: flex;
	flex-direction: column-reverse;
	gap: 8px;
	max-width: 380px;
	width: 100%;
	pointer-events: none;
}

/* ===== Toast ===== */
.toast {
	pointer-events: auto;
	background: var(--bg-card);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 12px 16px;
	-webkit-backdrop-filter: blur(12px);
	backdrop-filter: blur(12px);
	animation: slideIn 0.3s ease-out;
	position: relative;
}

.toast-high { border-left: 3px solid var(--red); }
.toast-medium { border-left: 3px solid var(--amber); }
.toast-low { border-left: 3px solid var(--blue); }

.toast-title {
	color: var(--text);
	font-weight: 600;
	font-size: 12px;
	margin-bottom: 4px;
}

.toast-body {
	color: var(--text-secondary);
	font-size: 11px;
	line-height: 1.4;
}

.toast-close {
	position: absolute;
	top: 8px;
	right: 8px;
	background: none;
	border: none;
	color: var(--text-muted);
	cursor: pointer;
	font-size: 14px;
	padding: 0;
	line-height: 1;
}

.toast-close:hover { color: var(--text); }

@keyframes slideIn {
	from { transform: translateX(100%); opacity: 0; }
	to { transform: translateX(0); opacity: 1; }
}

.toast-exit { animation: slideOut 0.2s ease-in forwards; }

@keyframes slideOut {
	to { transform: translateX(100%); opacity: 0; }
}

/* ===== Notification Bell & Settings Panel ===== */
.notification-bell {
	background: none;
	border: none;
	cursor: pointer;
	font-size: 18px;
	padding: 4px 8px;
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	position: relative;
}

.notification-bell:hover {
	background: var(--bg-card-hover);
	color: var(--text);
}

.notification-settings {
	position: absolute;
	top: 100%;
	right: 0;
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 12px;
	min-width: 200px;
	z-index: 10000;
	display: none;
}

.notification-settings.open { display: block; }

.notification-settings label {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 0;
	color: var(--text-secondary);
	font-size: 12px;
	cursor: pointer;
}

.notification-settings input[type="checkbox"] { accent-color: var(--blue); }

/* ===== Responsive ===== */
@media (max-width: 600px) {
	#toast-container { left: 10px; right: 10px; bottom: 10px; max-width: none; }
}
`;
