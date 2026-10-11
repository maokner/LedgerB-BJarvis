export { createDeviceManager, EndpointDeviceManager, parseDevicesEnv, APP_NAME, type DeviceManagerOptions } from "./manager.js";
export { createFakeDevice, FakeDeviceManager, type FakeAnswer, type FakeDevice, type FakePolicy, type ShownAction } from "./fake.js";
export { speculosEndpoint, speculosExchange } from "./transport-speculos.js";
export { hidEndpoint, listHidPaths } from "./transport-hid.js";
export * from "./apdu.js";
export { createEthDeviceManager, hidEthEndpoint, signOnEthApp, unsignedTx, verifyEthSignature, ETH_PATH, type EthApp, type EthEndpoint } from "./eth.js";
export { combineDeviceManagers, createRemoteDeviceManager, JOB_TTL_MS, type RemoteDeviceManager, type SubmitResult } from "./remote.js";
export { askEthApp, type EthAnswer, type EthRequest } from "./eth-tx.js";
export { ethProof, ethRequest } from "./eth-verify.js";
