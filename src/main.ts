import { app, BrowserWindow, globalShortcut, ipcMain, WebContents } from "electron";
import * as electron from "electron";
import * as path from "path";
import fetch from "node-fetch";
import { BrowserView, dialog, Menu, MenuItem, Tray, webContents } from "electron/main";
import { MenuItemConstructorOptions, nativeImage } from "electron/common";
import { handleSchemeArgs, handleSchemeCommand } from "./schemehandler";
import { readJsonWithBOM, relPath, rsClientExe, sameDomainResolve, schemestring, UserError, weborigin } from "./lib";
import { InstalledApp, identifyApp } from "./appconfig";
import { captureDesktop, getProcessMainWindow, getProcessesByName, OSWindow, OSWindowPin, captureDesktopMulti } from "./native";
import { detectInstances, RsInstance, rsInstances } from "./rsinstance";
import { OverlayCommand, Rectangle } from "./shared";

(global as any).native = require("./native");
(global as any).Alt1lite = require("./main");

export const installedApps: InstalledApp[] = [];
export const managedWindows: ManagedWindow[] = [];
export function getManagedWindow(w: webContents) { return managedWindows.find(q => q.window.webContents == w); }
export function getManagedAppWindow(id: number) { return managedWindows.find(q => q.appFrameId == id); }
var tray: Tray | null = null;
var alt1icon = nativeImage.createFromPath(relPath(require("!file-loader!./imgs/alt1icon.png").default));


//TODO this is needed for current native module, need to make it context aware
//app.allowRendererProcessReuse = false;
if (!app.requestSingleInstanceLock()) { app.exit(); }
app.setAsDefaultProtocolClient(schemestring, undefined, [__non_webpack_require__.main!.filename]);
handleSchemeArgs(process.argv);

app.on("second-instance", (e, argv, cwd) => handleSchemeArgs(argv));
app.on('window-all-closed', e => e.preventDefault());
app.once('ready', () => {

	//TODO only do this on config reset
	fetch(`${weborigin}/data/alt1/defaultapps.json`).then(r => readJsonWithBOM(r)).then(async (r: { folder: string, name: string, url: string }[]) => {
		for (let appbase of r) { await identifyApp(new URL(`${weborigin}${appbase.url}`)); }
		let stats = installedApps.find(a => a.configUrl == "http://localhost/apps/clue/appconfig.json")!;
		openApp(stats);
	});

	globalShortcut.register("Alt+1", () => { });

	drawTray();
	initIpcApi();
});

export function openApp(app: InstalledApp) {
	new ManagedWindow(app);
}
class ManagedWindow {
	appConfig: InstalledApp;
	window: BrowserWindow;
	nativeWindow: OSWindow;
	windowPin: OSWindowPin;
	rsClient: RsInstance;
	appFrameId = -1;

	constructor(app: InstalledApp) {
		this.window = new BrowserWindow({
			webPreferences: { nodeIntegration: true, webviewTag: true, enableRemoteModule: true },
			frame: false,
			//alwaysOnTop: true,
			width: app.defaultWidth,
			height: app.defaultHeight
		});

		detectInstances();
		this.rsClient = rsInstances[0];
		this.appConfig = app;

		this.nativeWindow = new OSWindow(this.window.getNativeWindowHandle());
		this.windowPin = this.nativeWindow.setPinParent(this.rsClient.window);
		this.window.loadFile(path.resolve(__dirname, "appframe/index.html"));
		this.window.webContents.openDevTools();
		this.window.once("close", () => {
			managedWindows.splice(managedWindows.indexOf(this), 1);
		});

		managedWindows.push(this);
	}
}

function drawTray() {
	tray = new Tray(alt1icon);
	tray.setToolTip("Alt1 Lite");
	tray.on("click", e => {
		let menu: MenuItemConstructorOptions[] = [];
		for (let app of installedApps) {
			menu.push({
				label: app.appName,
				icon: app.iconCached ? nativeImage.createFromDataURL(app.iconCached).resize({ height: 20, width: 20 }) : undefined,
				click: openApp.bind(null, app),
			});
		}
		menu.push({ type: "separator" });
		menu.push({ label: "Settings", click: showSettings });
		menu.push({ label: "Exit", click: e => app.quit() });
		menu.push({ label: "Restart", click: e => { app.relaunch(); app.quit(); } });
		let menuinst = Menu.buildFromTemplate(menu);
		tray!.setContextMenu(menuinst);
		tray!.popUpContextMenu();
	});
}

let settingsWnd: BrowserWindow | null = null;
export function showSettings() {
	if (settingsWnd) {
		settingsWnd.focusOnWebView();
		return;
	}
	settingsWnd = new BrowserWindow({
		webPreferences: { nodeIntegration: true, webviewTag: true, enableRemoteModule: true },
	});
	settingsWnd.loadFile(path.resolve(__dirname, "settings/index.html"));
	//settingsWnd.webContents.openDevTools();
	settingsWnd.once("closed", e => settingsWnd = null);
}

function initIpcApi() {
	ipcMain.on("identifyapp", async (e, configurl) => {
		try {
			let url = sameDomainResolve(e.sender.getURL(), configurl);
			identifyApp(url);
		} catch (e) {
			console.error(e);
		}
	});

	ipcMain.on("capturesync", (e, x, y, w, h) => {
		try {
			let wnd = getManagedAppWindow(e.sender.id);
			if (!wnd?.rsClient.window) { throw new Error("capture window not found"); }
			let bounds = wnd.rsClient.window.getClientBounds();
			e.returnValue = { value: { width: w, height: h, data: captureDesktop(x - bounds.x, y - bounds.y, w, h) } };
		} catch (err) {
			e.returnValue = { error: "" + err };
		}
	});

	//TODO remove
	ipcMain.handle("test", (e, buf) => { return buf; });

	ipcMain.on("rsbounds", (e) => {
		let wnd = getManagedAppWindow(e.sender.id);
		e.returnValue = { value: wnd?.rsClient.window.getClientBounds() };
	});

	ipcMain.handle("capture", (e, x, y, w, h) => {
		let wnd = getManagedAppWindow(e.sender.id);
		if (!wnd?.rsClient.window) { throw new Error("capture window not found"); }
		let bounds = wnd.rsClient.window.getClientBounds();
		return captureDesktop(x - bounds.x, y - bounds.y, w, h);
	});

	ipcMain.handle("capturemulti", (e, rects: { [key: string]: Rectangle }) => {
		let wnd = getManagedAppWindow(e.sender.id);;
		if (!wnd?.rsClient.window) { throw new Error("capture window not found"); }
		let bounds = wnd.rsClient.window.getClientBounds();
		for (let a in rects) {
			if (!rects[a]) { continue; }
			rects[a].x -= bounds.x;
			rects[a].y -= bounds.y;
		}
		return captureDesktopMulti(rects);
	});

	ipcMain.on("overlay", (e, commands: OverlayCommand[]) => {
		let wnd = getManagedAppWindow(e.sender.id);
		if (!wnd?.rsClient.window) { throw new Error("capture window not found"); }
		wnd.rsClient.overlayCommands(wnd.appFrameId, commands);
	});
}