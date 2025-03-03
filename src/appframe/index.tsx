//figure this one out for jsx
import * as React from "react";
import { useState, useLayoutEffect, useRef } from "react";
import { render } from "react-dom";
import { ipcRenderer, WebContents } from "electron";
import * as remote from "@electron/remote";
import classnames from "classnames";
import type { RectLike } from "@alt1/base";

import "./style.scss";
import "./index.html";
(window as any).remote = remote;
var appview: Electron.WebviewTag | null = null;
var appcontents: WebContents | null = null;
var mainmodule = remote.getGlobal("Alt1lite") as typeof import("../main");
//TODO backup if this fails
var thiswindow = mainmodule.getManagedWindow(remote.getCurrentWebContents())!;

window.addEventListener("DOMContentLoaded", () => {
	render(<AppFrame />, document.getElementById("root"));
});

function AppFrame(p: {}) {
	let el = useRef(null! as HTMLDivElement);

	let [rightclickArea, setRightclickArea] = useState(null as RectLike | null);
	let [minimized, setMinimized] = useState(false);
	let rootref = useRef(null);

	//app webview
	useLayoutEffect(() => {
		let view = document.createElement("webview");
		view.className = "appframe";
		view.preload = "./alt1api.bundle.js";
		view.allowpopups = true;
		view.nodeintegration = false;
		view.nodeintegrationinsubframes = false;
		view.src = thiswindow.appConfig.appUrl;
		//view.webpreferences = "sandbox,contextIsolation=true";
		view.webpreferences = "sandbox,contextIsolation=false";
		el.current.appendChild(view);
		view.addEventListener("dom-ready", e => {
			//TODO is there a better way to get a ref to the frame?
			thiswindow.appFrameId = view.getWebContentsId();
			appcontents = remote.webContents.fromId(appview!.getWebContentsId());
		});

		appview = view;
		//setparent doesnt work as expected
		// view.addEventListener("devtools-opened", e => {
		// 	let devwnd = (appcontents!.devToolsWebContents as any).getOwnerBrowserWindow();
		// 	let selfwnd = remote.getCurrentWindow();
		// 	if (devwnd && selfwnd) { devwnd.setParentWindow(selfwnd); }
		// });
		(window as any).view = view;
		return () => { appview = null };
	}, []);

	//rightclick even listener
	useLayoutEffect(() => {
		let handler = (e: any, rect: RectLike | null) => setRightclickArea(rect);
		ipcRenderer.on("rightclick", handler);
		return () => { ipcRenderer.off("rightclick", handler); };
	}, []);

	//transparent window clickthrough handler
	//https://github.com/electron/electron/issues/1335
	useLayoutEffect(clickThroughEffect.bind(null, minimized, rightclickArea, rootref), [minimized, rightclickArea]);

	let appstyle: React.CSSProperties = {};
	if (rightclickArea) {
		//TODO handle window scaling, the coords are in window client area pixel coords
		let rc = rightclickArea;
		//This method is current broken in electron but works in browser? maybe need update
		// let path = "";
		// //path around entire window
		// path += `M0 0 H${window.innerWidth} V${window.innerHeight} H0 Z `;
		// //second path around the rightclick area this erases it because of rule evenodd
		// path += `M${rightclickArea.x} ${rightclickArea.y} h${rightclickArea.width} v${rightclickArea.height} h${-rightclickArea.width} Z`;
		// appstyle.clipPath = `path(evenodd,"${path}")`;
		//kinda hacky this way with a 0 width line running through the clickable area but it works
		let path = "";
		path += `0 0, ${window.innerWidth}px 0, ${window.innerWidth}px ${window.innerHeight}px, 0 ${window.innerHeight}px,0 0,`;
		path += `${rc.x}px ${rc.y}px,${rc.x + rc.width}px ${rc.y}px, ${rc.x + rc.width}px ${rc.y + rc.height}px, ${rc.x}px ${rc.y + rc.height}px, ${rc.x}px ${rc.y}px`;
		appstyle.clipPath = `polygon(evenodd,${path})`;
	}

	return (
		<div className="approot" style={appstyle} ref={rootref}>
			<div className="appgrid" ref={el} style={{ display: minimized ? "none" : "", ...appstyle }} >
				<BorderEl ver="top" hor="left" />
				<BorderEl ver="top" hor="" />
				<BorderEl ver="top" hor="right" />
				<BorderEl ver="" hor="left" />
				<BorderEl ver="" hor="right" />
				<BorderEl ver="bot" hor="left" />
				<BorderEl ver="bot" hor="" />
				<BorderEl ver="bot" hor="right" />
			</div>
			<div className="buttonroot">
				<div className="button" onClick={e => close()} />
				<div className="button" onClick={e => setMinimized(!minimized)} />
				<div className="button" onClick={toggleDevTools} onContextMenu={e => e.preventDefault()} />
				<div className="dragbutton" />
			</div>
		</div>
	);
}

function toggleDevTools(e: React.MouseEvent) {
	if (e.button == 0) {
		if (appcontents) {
			if (appcontents.isDevToolsOpened()) { appcontents.closeDevTools(); }
			else { appcontents.openDevTools({ mode: "detach" }); }
		}
	} else if (e.button == 2) {
		let cnt = remote.getCurrentWebContents()
		if (cnt.isDevToolsOpened()) { cnt.closeDevTools(); }
		else { cnt.openDevTools({ mode: "detach" }); }
	}
}

function BorderEl(p: { ver: "top" | "bot" | "", hor: "left" | "right" | "" }) {
	return <div className={"border"}></div>
}

function startDrag(factors: { x: number, y: number, w: number, h: number }) {
	return function startDrag(starte: React.MouseEvent) {
		let initial = thiswindow.window.getBounds();
		starte.preventDefault();
		starte.stopPropagation();
		appview!.style.pointerEvents = "none";
		let startpos = remote.screen.getCursorScreenPoint();
		let moved = () => {
			let pos = remote.screen.getCursorScreenPoint();
			let dx = pos.x - startpos.x;
			let dy = pos.y - startpos.y;
			thiswindow.window.setBounds({
				x: initial.x + dx * factors.x,
				y:initial.y + dy * factors.y,
				width: initial.width + dx * factors.w,
				height: initial.height + dy * factors.h,
			});
			thiswindow.windowPin.updateDocking();
		};
		let cleanup = () => {
			window.removeEventListener("mousemove", moved);
			appview!.style.pointerEvents = "";
		}
		window.addEventListener("mousemove", moved);
		window.addEventListener("mouseup", cleanup, { once: true });
	}
}

function clickThroughEffect(minimized: boolean, rc: RectLike, rootref: React.MutableRefObject<any>) {
	let root = rootref.current as HTMLElement;
	if (minimized || rc) {
		if (process.platform != "linux") {
			//TODO check if this actually works when element is hidden while being hovered
			let currenthover = root.matches(":hover");
			thiswindow.window.setIgnoreMouseEvents(!currenthover, { forward: true });
			let handler = (e: MouseEvent) => {
				thiswindow.window.setIgnoreMouseEvents(e.type == "mouseleave", { forward: true });
			};
			root.addEventListener("mouseenter", handler);
			root.addEventListener("mouseleave", handler);
			return () => {
				root.removeEventListener("mouseenter", handler);
				root.removeEventListener("mouseleave", handler);
			}
		} else {
			// TODO: click-through on Linux using Shape API
			thiswindow.window.setIgnoreMouseEvents(false);
		}
	}
	thiswindow.window.setIgnoreMouseEvents(false);
}
