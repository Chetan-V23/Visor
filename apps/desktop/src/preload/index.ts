import { contextBridge, ipcRenderer } from 'electron'
import type { HistoryBridge, HistorySnapshot, HookBridge, HookSnapshot, MethodCode } from '@visor/bridge'
import type { Change, SessionSummary } from '@visor/protocol'

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

const history: HistoryBridge = {
	listSessions: async () => {
		const sessions: SessionSummary[] = await ipcRenderer.invoke('visor:history:sessions')
		return sessions
	},
	listChanges: async (sessionId) => {
		const changes: Change[] = await ipcRenderer.invoke('visor:history:changes', sessionId)
		return changes
	},
	getChange: async (id) => {
		const snapshot: HistorySnapshot | null = await ipcRenderer.invoke('visor:history:get', id)
		return snapshot
	},
	getMethodCode: async (request) => {
		const code: MethodCode | null = await ipcRenderer.invoke('visor:history:method', request)
		return code
	},
	onChangeAdded: (callback) => {
		const listener = (_event: Electron.IpcRendererEvent, change: Change) => callback(change)
		ipcRenderer.on('visor:changes:added', listener)
		return () => { ipcRenderer.removeListener('visor:changes:added', listener) }
	},
	onSessionsChanged: (callback) => {
		const listener = () => callback()
		ipcRenderer.on('visor:sessions:changed', listener)
		return () => { ipcRenderer.removeListener('visor:sessions:changed', listener) }
	}
}
contextBridge.exposeInMainWorld('visorHistory', history)