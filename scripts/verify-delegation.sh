#!/usr/bin/env bash
# VERIFY: the ArmorIQ human-in-the-loop approval lifecycle, end to end.
# No agent. No framework. Just the four HTTP calls your Slack button will make.
set -u

KEY=$(node -e "const c=require(process.env.USERPROFILE+'/.armoriq/credentials.json');console.log(Object.values(c.profiles)[0].apiKey)")
API="https://api.armoriq.ai"
REQ_EMAIL="${REQ_EMAIL:-maintainer@opencmo.dev}"
DOMAIN="${DOMAIN:-github.com}"

j() { python -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d,indent=2))" 2>/dev/null || cat; }

echo "=============================================================="
echo " STEP 1  POST /delegation/request"
echo " This is what ArmorIQ does internally when an agent exceeds"
echo " its policy limit. Here we raise it by hand."
echo "=============================================================="

REQ_BODY=$(cat <<EOF
{
  "action": "github_merge_pull_request",
  "arguments": { "pr": 42, "repo": "Sahil-Gupta584/opencmo" },
  "requesterRole": "agent",
  "requesterLimit": 0,
  "domain": "$DOMAIN",
  "amount": 0.01
}
EOF
)

RESP=$(curl -s -m 30 -X POST "$API/delegation/request" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "X-User-Email: $REQ_EMAIL" -d "$REQ_BODY")

echo "$RESP" | j

DELEGATION_ID=$(echo "$RESP" | python -c "import sys,json;print(json.load(sys.stdin).get('delegationId',''))" 2>/dev/null)

if [ -z "$DELEGATION_ID" ]; then
  echo ""
  echo "!! No delegationId returned. See the error above."
  echo "   Common causes: requesterLimit too high, role not recognised,"
  echo "   or amount below 0.01. Paste this output and we'll adjust."
  exit 1
fi

echo ""
echo "delegationId = $DELEGATION_ID"
echo ""
echo ">>> OPEN THIS NOW, while this script waits:"
echo "    https://platform.armoriq.ai"
echo "    Go to Plans -> filter 'Needs you'. You should see this request."
echo ""

echo "=============================================================="
echo " STEP 2  GET /delegation/poll   (before approval)"
echo "=============================================================="
curl -s -m 30 "$API/delegation/poll?delegationId=$DELEGATION_ID" \
  -H "x-api-key: $KEY" -H "X-User-Email: $REQ_EMAIL" | j

echo ""
echo "=============================================================="
echo " STEP 3  POST /delegation/approve"
echo " *** THIS IS THE CALL YOUR SLACK BUTTON WILL MAKE ***"
echo "=============================================================="

APPROVER="${APPROVER_EMAIL:-$REQ_EMAIL}"
echo "approving as: $APPROVER"
curl -s -m 30 -X POST "$API/delegation/approve" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "X-User-Email: $APPROVER" \
  -d "{\"delegationId\":\"$DELEGATION_ID\",\"approverEmail\":\"$APPROVER\"}" | j

echo ""
echo "=============================================================="
echo " STEP 4  GET /delegation/poll   (after approval)"
echo "=============================================================="
curl -s -m 30 "$API/delegation/poll?delegationId=$DELEGATION_ID" \
  -H "x-api-key: $KEY" -H "X-User-Email: $APPROVER" | j

echo ""
echo "=============================================================="
echo " Expected: status changed pending -> approved"
echo " If it did, the ENTIRE approval flow works end to end."
echo "=============================================================="