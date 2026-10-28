from collections.abc import Callable

from .contracts import JSON


class SemanticError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        uncertain: bool = False,
        *,
        diagnostics: JSON | None = None,
    ):
        super().__init__(code)
        self.status = status
        self.code = code
        self.uncertain = uncertain
        # Internal diagnostics only; never part of the browser error contract.
        self.diagnostics = diagnostics or {}


def error_details(error: Exception) -> JSON:
    """Fixed summaries and structured metadata, never raw exception/provider text."""
    descriptions = {
        "unauthorized": "Session authentication failed.",
        "forbidden": "Caller is not an allowed member.",
        "database_error": "Supabase request failed.",
        "database_invalid": "Supabase returned an unexpected data structure.",
        "rpc_rejected": "Supabase RPC rejected the request.",
        "conflict": "Request ID was already used with different input.",
        "quota_exceeded": "Daily semantic entry quota exceeded.",
        "provider_configuration": "Gemini key or model configuration is invalid.",
        "provider_error": "Gemini HTTP request failed.",
        "provider_invalid": "Gemini output did not match the expected contract.",
        "provider_refusal": "Gemini refused the request.",
        "provider_timeout": "Gemini request exceeded its deadline.",
        "persist_uncertain": "Request outcome could not be confirmed before the deadline.",
        "image_forbidden_path": "Image path does not belong to the caller.",
        "image_too_large": "Image size is outside the allowed range.",
        "image_limit": "Image count or total size exceeds the allowed limit.",
        "image_unsupported": "Image type or signature is unsupported.",
        "image_not_found": "Image was not found.",
        "image_changed": "Image changed after metadata verification.",
        "image_error": "Image storage operation failed.",
        "image_configuration": "Image storage is not configured.",
        "unsupported_version": "Result requires a supported semantic version.",
        "service_error": "Unexpected service exception.",
    }
    if isinstance(error, SemanticError):
        message = descriptions.get(error.code, "Semantic entry request failed.")
        if error.code == "provider_error" and error.diagnostics.get("upstreamField"):
            message = (
                f"Gemini rejected parameter: {error.diagnostics['upstreamField']}."
            )
        return {
            "severity": "ERROR",
            "errorCode": error.code,
            "errorMessage": message,
            "httpStatus": error.status,
            "uncertain": error.uncertain,
            **error.diagnostics,
        }
    return {
        "severity": "ERROR",
        "errorCode": "service_error",
        "errorMessage": descriptions["service_error"],
        "exceptionType": type(error).__name__,
    }


def log_failure(
    logger: Callable[[JSON], None] | None,
    node: str,
    error: Exception,
    identifier: str | None,
    elapsed_ms: int,
) -> None:
    try:
        if logger:
            logger(
                {
                    "node": node,
                    "status": "error",
                    "elapsedMs": elapsed_ms,
                    **({"requestId": identifier} if identifier else {}),
                    **error_details(error),
                }
            )
    except Exception:
        pass  # Diagnostic failures must not change request/write outcomes.
