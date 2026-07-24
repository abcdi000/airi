class LumiBridgeError(Exception):
    """Base class for failures safe to classify at the AstrBot boundary."""


class LumiUnavailableError(LumiBridgeError):
    pass


class LumiTimeoutError(LumiBridgeError):
    pass


class LumiAuthenticationError(LumiBridgeError):
    pass


class LumiIdentityUnboundError(LumiBridgeError):
    pass


class LumiProtocolError(LumiBridgeError):
    pass


class MediaDownloadError(LumiBridgeError):
    pass


class UnsupportedMediaError(LumiBridgeError):
    pass


class MediaTooLargeError(LumiBridgeError):
    pass


class AudioConversionError(LumiBridgeError):
    pass


class VisionUnavailableError(LumiBridgeError):
    pass


class HearingUnavailableError(LumiBridgeError):
    pass


class DuplicateEventError(LumiBridgeError):
    pass
