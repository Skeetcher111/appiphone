'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listDevices: () => ipcRenderer.invoke('device:list'),
  deviceInfo: (udid) => ipcRenderer.invoke('device:info', udid),
  installIPA: (udid, ipaPath, appName) => ipcRenderer.invoke('ipa:install', { udid, ipaPath, appName }),
  openAppleDevicesStore: () => ipcRenderer.invoke('app:openAppleDevicesStore'),
  openSupportChat: () => ipcRenderer.invoke('app:openSupportChat'),
  onLog: (cb) => ipcRenderer.on('ipa:log', (_e, line) => cb(line)),
  // Каталог-кэш (фаза 1.6)
  listCacheApps: () => ipcRenderer.invoke('cache:list'),
  prepareCacheApp: (appleAppId, externalVersionId, name) => ipcRenderer.invoke('cache:prepare', { appleAppId, externalVersionId, name }),
  // Общая витрина-каталог (фаза 2.1) — до 200 приложений для всех
  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  getCatalogIcons: (items) => ipcRenderer.invoke('catalog:icons', { items }),
  lookupAppId: (id) => ipcRenderer.invoke('catalog:lookup', { id }),
  ownershipGet: () => ipcRenderer.invoke('ownership:get'),
  ownershipSyncPurchases: () => ipcRenderer.invoke('ownership:syncPurchases'),
  onOwnershipProgress: (cb) => ipcRenderer.on('ownership:progress', (_e, data) => cb(data)),
  ownershipCheckPriority: (items) => ipcRenderer.invoke('ownership:checkPriority', { items }),
  pausePriorityCheck: () => ipcRenderer.invoke('ownership:pausePriorityCheck'),
  clearFailedOwnership: () => ipcRenderer.invoke('ownership:clearFailed'),
  onPriorityProgress: (cb) => ipcRenderer.on('priority:progress', (_e, data) => cb(data)),
  cancelOp: () => ipcRenderer.invoke('ipa:cancel'),
  // Папка-библиотека .ipa
  ipaFolderInfo: () => ipcRenderer.invoke('ipa:cacheDirInfo'),
  openIpaFolder: () => ipcRenderer.invoke('ipa:openCacheDir'),
  pickIpaFolder: () => ipcRenderer.invoke('ipa:pickCacheDir'),
  resetIpaFolder: () => ipcRenderer.invoke('ipa:resetCacheDir'),
  // Apple ID / аккаунты
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountSetActive: (email) => ipcRenderer.invoke('accounts:setActive', email),
  accountLogin: (payload) => ipcRenderer.invoke('accounts:login', payload),
  accountRequestCode: (payload) => ipcRenderer.invoke('accounts:requestCode', payload),
  accountRemove: (email) => ipcRenderer.invoke('accounts:remove', email),
  checkAppleReachability: () => ipcRenderer.invoke('accounts:checkAppleReachability'),
  // Баланс установок и оплата (фаза 2.2)
  machineStatus: (udid) => ipcRenderer.invoke('machine:status', { udid }),
  buyInstalls: (qty) => ipcRenderer.invoke('payments:create', { qty }),
  donate: (amountRub) => ipcRenderer.invoke('payments:donate', { amountRub }),
  paymentStatus: (paymentId) => ipcRenderer.invoke('payments:status', { paymentId }),
  // Авторизация (отдельный аккаунт от веб-панели /admin, снимает лимиты)
  authLogin: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  // Автообновление (фаза 5)
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, version) => cb(version)),
  installUpdateNow: () => ipcRenderer.invoke('update:installNow'),
});
