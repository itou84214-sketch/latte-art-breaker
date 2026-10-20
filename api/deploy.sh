#!/usr/bin/env bash
# =========================================================================
#  みんなのラテアート — 置き場を AWS に作る
#  -------------------------------------------------------------------------
#  作るもの（3 つだけ）
#    1. DynamoDB のテーブル 1 つ（投稿の保存先）
#    2. Lambda に持たせる権限（そのテーブルだけ触れる役割）
#    3. Lambda 関数と、その入口になる URL
#
#  何度流しても同じ結果になるように書いてあります（すでに在れば作り直さない）。
#
#    bash api/deploy.sh
# =========================================================================
set -euo pipefail

REGION=${REGION:-ap-northeast-1}
TABLE=${TABLE:-latte-art-posts}
FUNC=${FUNC:-latte-art-api}
ROLE=${ROLE:-latte-art-api-role}
# 暴走したときの上限。これ以上は同時に動かない＝費用も頭打ちになる
CONCURRENCY=${CONCURRENCY:-5}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "アカウント $ACCOUNT / リージョン $REGION"

# ---------------------------------------------------------------- 1. テーブル
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "[1/3] テーブル $TABLE … すでにある"
else
  echo "[1/3] テーブル $TABLE を作る"
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --region "$REGION" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
        AttributeName=id,AttributeType=S \
        AttributeName=kind,AttributeType=S \
        AttributeName=created,AttributeType=N \
    --key-schema AttributeName=id,KeyType=HASH \
    --global-secondary-indexes '[{
        "IndexName": "byCreated",
        "KeySchema": [
          {"AttributeName":"kind","KeyType":"HASH"},
          {"AttributeName":"created","KeyType":"RANGE"}
        ],
        "Projection": {"ProjectionType":"ALL"}
      }]' >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
  # 期限切れの項目（連続投稿よけの札・古い投稿）を自動で片づける
  aws dynamodb update-time-to-live \
    --table-name "$TABLE" --region "$REGION" \
    --time-to-live-specification "Enabled=true,AttributeName=expires" >/dev/null
  echo "      作成しました"
fi

# ------------------------------------------------------------------ 2. 権限
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "[2/3] 役割 $ROLE … すでにある"
else
  echo "[2/3] 役割 $ROLE を作る"
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document "$TRUST" >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo "      作成しました（権限が行き渡るまで 10 秒待ちます）"
  sleep 10
fi

# このテーブルだけを触れる権限。他の AWS の資源には手が届きません。
aws iam put-role-policy --role-name "$ROLE" --policy-name latte-art-table \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"dynamodb:GetItem\",\"dynamodb:PutItem\",
                   \"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:Query\"],
      \"Resource\": [
        \"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\",
        \"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE/index/*\"
      ]
    }]
  }" >/dev/null

# ------------------------------------------------------------------ 3. 関数
# Windows 版の aws CLI は Git Bash の /c/... 形式を読めないので、
# 日本語を含まない一時フォルダに置き、渡すときは C:/... 形式に直す。
if command -v cygpath >/dev/null 2>&1; then
  BUILD="${TEMP:-/tmp}/latte-art-build"
  BUILD="$(cygpath -u "$BUILD" 2>/dev/null || echo "$BUILD")"
else
  BUILD="$HERE"
fi
mkdir -p "$BUILD"
ZIP="$BUILD/function.zip"
rm -f "$ZIP"

# zip コマンドは Windows に無いので、どこにでもある Python で固める
python - "$HERE/index.mjs" "$ZIP" <<'PYZIP'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(src, "index.mjs")
PYZIP
[ -s "$ZIP" ] || { echo "function.zip を作れませんでした" >&2; exit 1; }

# aws に渡す形
ZIPREF="$ZIP"
command -v cygpath >/dev/null 2>&1 && ZIPREF="$(cygpath -m "$ZIP")"

if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  echo "[3/3] 関数 $FUNC … 中身を入れ替える"
  aws lambda update-function-code --function-name "$FUNC" --region "$REGION" \
    --zip-file "fileb://$ZIPREF" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
else
  echo "[3/3] 関数 $FUNC を作る"
  aws lambda create-function --function-name "$FUNC" --region "$REGION" \
    --runtime nodejs22.x --handler index.handler \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" \
    --zip-file "fileb://$ZIPREF" \
    --timeout 10 --memory-size 256 \
    --environment "Variables={TABLE=$TABLE}" >/dev/null
  aws lambda wait function-active --function-name "$FUNC" --region "$REGION"
fi

aws lambda put-function-concurrency --function-name "$FUNC" --region "$REGION" \
  --reserved-concurrent-executions "$CONCURRENCY" >/dev/null

# 入口の URL。誰でも呼べる状態にします（投稿してもらうページなので）
if ! aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FUNC" --region "$REGION" \
    --auth-type NONE \
    --cors '{"AllowOrigins":["*"],"AllowMethods":["GET","POST"],"AllowHeaders":["content-type"],"MaxAge":86400}' >/dev/null
  # 2025 年 10 月以降、誰でも呼べる URL には許可が 2 つ要る。
  # 片方だけだと入口で 403 になり、関数まで届かない。
  aws lambda add-permission --function-name "$FUNC" --region "$REGION" \
    --statement-id public-url --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FUNC" --region "$REGION" \
    --statement-id public-url-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null
fi

URL=$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" \
        --query FunctionUrl --output text)
rm -f "$ZIP"

echo
echo "========================================================"
echo " 入口の URL: $URL"
echo "========================================================"
echo " config.js の LATTE_API にこの URL を入れて、S3 に上げてください。"
