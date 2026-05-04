export type DeviceCapabilities = {
  canListDevices: boolean;
  canReadLogs: boolean;
  canCaptureScreenshot: boolean;
  canListWebviews: boolean;
  canAttachWebview: boolean;
  canEvalJs: boolean;
  canReadConsole: boolean;
  canReadNetwork: boolean;
  canScreencast: boolean;
  canAutomateNativeUi: boolean;
  canInstallApp: boolean;
  canLaunchApp: boolean;
};

export const unsupportedCapabilities = (): DeviceCapabilities => ({
  canListDevices: false,
  canReadLogs: false,
  canCaptureScreenshot: false,
  canListWebviews: false,
  canAttachWebview: false,
  canEvalJs: false,
  canReadConsole: false,
  canReadNetwork: false,
  canScreencast: false,
  canAutomateNativeUi: false,
  canInstallApp: false,
  canLaunchApp: false,
});

export const androidScaffoldCapabilities = (): DeviceCapabilities => ({
  ...unsupportedCapabilities(),
  canListDevices: true,
});

export const androidDeviceCapabilities = (): DeviceCapabilities => ({
  ...unsupportedCapabilities(),
  canListDevices: true,
  canReadLogs: true,
  canCaptureScreenshot: true,
  canListWebviews: true,
  canAttachWebview: true,
  canEvalJs: true,
  canReadConsole: true,
  canReadNetwork: true,
  canLaunchApp: true,
});
