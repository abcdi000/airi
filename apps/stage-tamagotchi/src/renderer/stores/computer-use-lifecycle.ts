export function didComputerUseSendingStart(sending: boolean, wasSending: boolean | undefined) {
  return sending && wasSending !== true
}

export function didComputerUseSendingEnd(sending: boolean, wasSending: boolean | undefined) {
  return !sending && wasSending === true
}
