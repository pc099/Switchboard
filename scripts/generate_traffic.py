import time
import requests
import random
import sys

# Configuration
PROXY_URL = "http://localhost:8080/v1"
HEADERS = {
    "X-Switchboard-Token": "demo_token_123",
    "X-Agent-Id": "traffic_gen"
}

# Payload templates
NORMAL_REQUEST = {
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Tell me a joke"}]
}

PII_REQUEST = {
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "My email is test@company.com"}]
}

SQL_REQUEST = {
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "DROP TABLE users;"}]
}

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")

def send_request(payload, type_label):
    try:
        res = requests.post(f"{PROXY_URL}/chat/completions", json=payload, headers=HEADERS, timeout=5)
        status = res.status_code
        if status == 200:
            log(f"✅ {type_label}: 200 OK")
        elif status == 403:
            log(f"🛡️ {type_label}: 403 BLOCKED (Firewall active)")
        elif status == 502:
            log(f"⚠️ {type_label}: 502 (Allowed but upstream failed - Shadow Mode?)")
        else:
            log(f"❓ {type_label}: {status}")
    except Exception as e:
        log(f"❌ {type_label}: Failed - {e}")

def main():
    log("🚀 Starting Traffic Generator for Dynamic UI Demo...")
    count = 1
    try:
        while True:
            # Mix of traffic
            r = random.random()
            
            if r < 0.6:
                send_request(NORMAL_REQUEST, "Normal Request")
            elif r < 0.8:
                send_request(PII_REQUEST, "PII Request")
            else:
                send_request(SQL_REQUEST, "Destructive Request")
            
            log(f"--- Batch {count} complete. Waiting... ---")
            count += 1
            time.sleep(2) # 2 seconds delay
    except KeyboardInterrupt:
        log("\n🛑 Traffic generator stopped")

if __name__ == "__main__":
    main()
