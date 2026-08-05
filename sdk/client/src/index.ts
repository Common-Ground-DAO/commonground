export { CommonGroundClient, type CommonGroundClientOptions } from "./client.js";
export { HttpTransport, type HttpTransportOptions } from "./transport/http.js";
export { CookieJar } from "./transport/cookies.js";
export { ApiError, TransportError, type ApiErrorCode } from "./transport/errors.js";
export { fetchInstanceConfig, type InstanceConfig, type CaptchaProvider } from "./instance.js";
export { DeviceKey, type DeviceCurve, type DevicePublicJwk, type DeviceKeyExport } from "./identity/deviceKey.js";
export {
  solveAltchaChallenge,
  buildCaptchaToken,
  fetchCaptchaConfig,
  fetchAltchaChallenge,
  obtainCaptchaToken,
  type AltchaChallenge,
  type AltchaSolution,
} from "./captcha/altcha.js";
export { AuthApi, type RegisterOptions, type AuthSession } from "./auth/api.js";
export type {
  OwnData,
  UserData,
  LoginResponse,
  OnlineStatus,
  ProfileItemType,
  CreateUserRequest,
} from "./auth/types.js";
