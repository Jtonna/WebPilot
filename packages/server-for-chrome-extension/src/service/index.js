'use strict';

function getServiceModule() {
  switch (process.platform) {
    case 'win32':
      return require('./windows');
    case 'darwin':
      return require('./macos');
    case 'linux':
      return require('./linux');
    default:
      return null;
  }
}

function install() {
  const mod = getServiceModule();
  if (!mod) {
    return {
      success: false,
      message: `Platform "${process.platform}" is not supported for service registration.`,
    };
  }
  return mod.install();
}

function uninstall() {
  const mod = getServiceModule();
  if (!mod) {
    return {
      success: false,
      message: `Platform "${process.platform}" is not supported for service registration.`,
    };
  }
  return mod.uninstall();
}

function status() {
  const mod = getServiceModule();
  if (!mod) {
    return {
      success: false,
      registered: false,
      running: false,
      message: `Platform "${process.platform}" is not supported for service registration.`,
    };
  }
  return mod.status();
}

module.exports = { install, uninstall, status };
