"""Time the same representative and large workloads as ../ts/benchmark.ts."""

import argparse
import json
import math
import os
import platform
import sys
from importlib.metadata import version
from pathlib import Path

from fastapi.testclient import TestClient

from contract import MEDIA_TYPE, load_spec, operation
from spike import CANDIDATES, server

BUDGET_MS = 5
BRAND = {
    "key": "acme",
    "kind": "primary",
    "name": "Acme",
    "aliases": ["Acme Co."],
    "domains": ["example.com"],
}
REPRESENTATIVE = {
    "text": "Acme is mentioned in a representative answer. " * 25,
    "brands": [BRAND, {**BRAND, "key": "other", "kind": "competitor", "name": "Other"}],
    "sentiment": {"language": "en-US", "analyzers": ["det:lexicon", "det:rules"]},
}
LARGE = {
    "text": "a" * 200_000,
    "brands": [
        {
            **BRAND,
            "key": f"brand-{i}",
            "kind": "competitor" if i else "primary",
            "aliases": [f"alias-{j}" for j in range(20)],
            "domains": [f"host{j}.example.com" for j in range(20)],
        }
        for i in range(50)
    ],
    "sentiment": {},
}
WORKLOADS = [
    ("representative", REPRESENTATIVE, 500, 5_000),
    ("large", LARGE, 200, 1_000),
]


def cpu_model():
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.is_file():
        for line in cpuinfo.read_text().splitlines():
            if line.startswith("model name"):
                return line.partition(":")[2].strip()
    return platform.processor() or platform.machine()


def measure(spec, path, payload, warmup, samples, candidate):
    timings = []
    with TestClient(
        server(spec, measure=timings.append, candidate=candidate)
    ) as client:
        for _ in range(warmup + samples):
            response = client.post(
                path, content=payload, headers={"content-type": MEDIA_TYPE}
            )
            assert response.status_code == 200, response.text
    assert len(timings) == warmup + samples
    measured = sorted(timings[warmup:])
    return [
        measured[math.ceil(samples * percentile) - 1] for percentile in (0.50, 0.99)
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report-only", action="store_true", help="Record a miss as evidence."
    )
    parser.add_argument("--candidate", choices=CANDIDATES, default="openapi-core")
    args = parser.parse_args()
    packages = ("fastapi", "openapi-core", "jsonschema")
    print(
        f"{platform.python_implementation()} {platform.python_version()} | {platform.platform()} | {cpu_model()}"
    )
    print(
        f"Runner image: {os.environ.get('ImageOS', 'local')} {os.environ.get('ImageVersion', '')}"
    )
    print(" | ".join(f"{package} {version(package)}" for package in packages))
    print(
        f"Validator including defaults only | strict p99 < {BUDGET_MS} ms", flush=True
    )
    spec = load_spec()
    _, path, _ = operation(spec)
    passed = True
    for name, body, warmup, samples in WORKLOADS:
        payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
        p50, p99 = measure(spec, path, payload, warmup, samples, args.candidate)
        within_budget = p99 < BUDGET_MS
        passed &= within_budget
        print(
            f"{args.candidate} | {name} | {len(payload)} bytes | warmup {warmup} | n={samples} | "
            f"p50 {p50:.4f} ms | p99 {p99:.4f} ms | {'PASS' if within_budget else 'FAIL'}",
            flush=True,
        )
    return 0 if passed or args.report_only else 1


if __name__ == "__main__":
    sys.exit(main())
