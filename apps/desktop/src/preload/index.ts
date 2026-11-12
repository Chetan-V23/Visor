import { contextBridge, ipcRenderer } from 'electron'
import type { HookBridge, HookSnapshot } from '@visor/bridge'

const bridge: HookBridge = {
	getSnapshot: async () => {
		const snapshot: HookSnapshot = await ipcRenderer.invoke('visor:hooks:get')
		return snapshot
	},
	setDebugEnabled: async (enabled) => {
		const snapshot: HookSnapshot = await ipcRenderer.invoke('visor:hooks:debug', enabled)
		return snapshot
	},
	onSnapshot: (callback) => {
		const listener = (_event: Electron.IpcRendererEvent, snapshot: HookSnapshot) => callback(snapshot)
		ipcRenderer.on('visor:hooks:snapshot', listener)
		return () => { ipcRenderer.removeListener('visor:hooks:snapshot', listener) }
	}
}

contextBridge.exposeInMainWorld('visorHooks', bridge)