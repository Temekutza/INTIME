class ApiError(Exception):
    status_code = 400

    def __init__(self, detail: str) -> None:
        self.detail = detail
        super().__init__(detail)


class Unauthorized(ApiError):
    status_code = 401


class NotFound(ApiError):
    status_code = 404


class Conflict(ApiError):
    status_code = 409


class Unprocessable(ApiError):
    status_code = 422


class BadGateway(ApiError):
    status_code = 502


class ServiceUnavailable(ApiError):
    status_code = 503
