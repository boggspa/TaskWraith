export const IOS_REMOTE_ENABLED =
  typeof __IOS_REMOTE_TRUE__ !== 'undefined' ? __IOS_REMOTE_TRUE__ : true

export const CHANNELS_GATEWAY_ENABLED =
  typeof __CHANNELS_GATEWAY_ENABLED__ !== 'undefined'
    ? __CHANNELS_GATEWAY_ENABLED__
    : typeof __MESSAGES_BRIDGE_ENABLED__ !== 'undefined'
      ? __MESSAGES_BRIDGE_ENABLED__
      : false

export const MESSAGES_BRIDGE_ENABLED = CHANNELS_GATEWAY_ENABLED
