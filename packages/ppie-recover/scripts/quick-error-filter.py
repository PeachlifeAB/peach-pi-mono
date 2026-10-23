import json
import sys


def find_errors(data):
    """Recursively search for error flags in a JSON object."""
    if isinstance(data, dict):
        # Check for Pi Agent specific error flags
        if data.get("stopReason") == "error" or data.get("isError") is True:
            return True
        return any(find_errors(v) for v in data.values())
    elif isinstance(data, list):
        return any(find_errors(item) for item in data)
    return False


def main(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            if not line.strip():
                continue

            try:
                event = json.loads(line)
                if find_errors(event):
                    # You can customize this to print specific nested fields
                    # like event.get("message", {}).get("errorMessage")
                    print(f"--- Error found on line {line_num} ---")
                    print(json.dumps(event, indent=2))
            except json.JSONDecodeError:
                print(f"Failed to parse line {line_num}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python filter_errors.py <session.jsonl>")
        sys.exit(1)

    main(sys.argv[1])
