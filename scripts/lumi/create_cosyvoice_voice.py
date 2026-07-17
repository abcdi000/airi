#!/usr/bin/env python3
"""
Create a CosyVoice custom voice and print the returned voice_id.

This uses the DashScope/Bailian REST API directly, so it does not require the
dashscope Python SDK. Keep API keys in environment variables, not in this file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


CN_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
INTL_ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a CosyVoice voice clone/design voice_id via DashScope.",
    )
    parser.add_argument(
        "--url",
        required=True,
        help="Publicly accessible wav/mp3 audio URL used for voice cloning.",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("DASHSCOPE_API_KEY"),
        help="DashScope/Bailian API key. Defaults to DASHSCOPE_API_KEY.",
    )
    parser.add_argument(
        "--region",
        choices=("cn", "intl"),
        default="cn",
        help="cn uses Beijing endpoint; intl uses Singapore endpoint.",
    )
    parser.add_argument(
        "--target-model",
        default="cosyvoice-v3.5-flash",
        help="CosyVoice model that will later use this voice_id.",
    )
    parser.add_argument(
        "--prefix",
        default="lumi",
        help="Voice name prefix. Official limit: letters/numbers/underscore, <= 10 chars.",
    )
    parser.add_argument(
        "--language-hint",
        action="append",
        default=None,
        help="Optional language hint, e.g. zh. Can be repeated; current API uses the first.",
    )
    parser.add_argument(
        "--max-prompt-audio-length",
        type=float,
        default=None,
        help="Optional reference audio max length in seconds, range 3.0-30.0.",
    )
    parser.add_argument(
        "--enable-preprocess",
        action="store_true",
        help="Enable denoise/enhance/volume normalization before cloning.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not args.api_key:
        raise SystemExit("Missing API key. Set DASHSCOPE_API_KEY or pass --api-key.")
    if len(args.prefix) > 10:
        raise SystemExit("--prefix must be 10 characters or fewer.")
    if not all(ch.isalnum() or ch == "_" for ch in args.prefix):
        raise SystemExit("--prefix may only contain letters, numbers, and underscore.")
    if args.max_prompt_audio_length is not None:
        if not 3.0 <= args.max_prompt_audio_length <= 30.0:
            raise SystemExit("--max-prompt-audio-length must be in [3.0, 30.0].")


def build_body(args: argparse.Namespace) -> dict:
    input_body: dict = {
        "action": "create_voice",
        "target_model": args.target_model,
        "prefix": args.prefix,
        "url": args.url,
    }
    if args.language_hint:
        input_body["language_hints"] = args.language_hint

    parameters: dict = {}
    if args.max_prompt_audio_length is not None:
        parameters["max_prompt_audio_length"] = args.max_prompt_audio_length
    if args.enable_preprocess:
        parameters["enable_preprocess"] = True

    body = {
        "model": "voice-enrollment",
        "input": input_body,
    }
    if parameters:
        body["parameters"] = parameters
    return body


def post_json(endpoint: str, api_key: str, body: dict) -> dict:
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return json.loads(response_body)
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"DashScope HTTP {error.code}: {error_body}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"DashScope request failed: {error}") from error


def main() -> int:
    args = parse_args()
    validate_args(args)

    endpoint = CN_ENDPOINT if args.region == "cn" else INTL_ENDPOINT
    body = build_body(args)
    result = post_json(endpoint, args.api_key, body)

    voice_id = result.get("output", {}).get("voice_id")
    request_id = result.get("request_id")

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if voice_id:
        print()
        print(f"VOICE_ID={voice_id}")
        if request_id:
            print(f"REQUEST_ID={request_id}")
        return 0

    print("No output.voice_id found in response.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
