// =========================================================================
//  みんなのラテアート — 投稿の置き場
//  -------------------------------------------------------------------------
//  AWS Lambda の Function URL から直接呼ばれます（API Gateway は使いません）。
//  保存先は DynamoDB のテーブル 1 つだけ。絵は 384x384 の白黒 PNG を
//  data URL のまま入れています（1 件あたり 20 KB 弱なので、
//  DynamoDB の 1 項目 400 KB にじゅうぶん収まります）。
//
//  投稿はすべて名無しです。名前やメールを受け取る口は作っていません。
//
//  受け取る操作
//    GET  ?action=list&limit=N   新しい順に一覧を返す
//    POST {action:"post",   png}        投稿する → 消すための鍵を返す
//    POST {action:"like",   id}         いいねを 1 増やす
//    POST {action:"unlike", id}         いいねを 1 減らす
//    POST {action:"delete", id, token}  自分の投稿を消す
// =========================================================================
import {
  DynamoDBClient, PutItemCommand, QueryCommand,
  UpdateItemCommand, DeleteItemCommand, GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { randomUUID, createHash } from 'node:crypto';

const db    = new DynamoDBClient({});
const TABLE = process.env.TABLE || 'latte-art-posts';

// --- 制限値 ---------------------------------------------------------------
const MAX_PNG   = 120_000;  // data URL の文字数
// 画面側は 384x384 の絵を白黒 PNG にして送ります。実測で、びっしり描いた絵が
// 24,634 字、それを崩した絵が 38,190 字。上限はその 3 倍ほどに取っています。
// 以前は 60,000 字で、画面側が赤緑青＋透明の 4 色ぶんを書いていたため、
// 崩した絵が 87,338 字になって弾かれていました。古い画面がまだ開いたままでも
// 通るように、その値より上に置いています。
const MAX_LIST  = 48;       // 1 回に返す件数
const COOL_SEC  = 20;       // 同じ相手からの連続投稿を断る秒数
const KEEP_DAYS = 365;      // この日数が過ぎた投稿は DynamoDB が自動で消す

// 他サイトからの呼び出し許可（CORS）は、ここでは付けません。
// Function URL 側の設定が同じヘッダーを付けるため、両方で付けると
// access-control-allow-origin が 2 つ並び、ブラウザが無効と判断します。
const HEAD = {
  'content-type':  'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const reply = (code, body) => ({
  statusCode: code,
  headers: HEAD,
  body: JSON.stringify(body),
});

const S = (v) => (v && v.S) || '';
const N = (v) => Number((v && v.N) || 0);

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || 'GET';
  // OPTIONS（事前確認）は Function URL 側が自分で返すので、ここには来ません。
  if (method === 'OPTIONS') return { statusCode: 204, headers: HEAD };

  try {
    if (method === 'GET')  return await list(event);
    if (method === 'POST') return await write(event);
    return reply(405, { error: 'この呼び方には対応していません' });
  } catch (e) {
    console.error(e);
    return reply(500, { error: 'サーバー側で問題が起きました' });
  }
};

// --- 一覧 -----------------------------------------------------------------
async function list(event) {
  const q = event?.queryStringParameters || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 24, 1), MAX_LIST);

  const r = await db.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'byCreated',
    KeyConditionExpression: 'kind = :k',
    ExpressionAttributeValues: { ':k': { S: 'post' } },
    ScanIndexForward: false,          // 新しい順
    Limit: limit,
    ExclusiveStartKey: startKey(q.after),
  }));

  return reply(200, {
    posts: (r.Items || []).map((it) => ({
      id:      S(it.id),
      png:     S(it.png),
      likes:   N(it.likes),
      created: N(it.created),
    })),
    next: r.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString('base64url')
      : null,
  });
}

function startKey(after) {
  if (!after) return undefined;
  try { return JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); }
  catch { return undefined; }
}

// --- 書き込み -------------------------------------------------------------
async function write(event) {
  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}');
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: '受け取った内容を読めませんでした' });
  }

  if (body.action === 'post')   return await create(body, event);
  if (body.action === 'like')   return await vote(body.id,  1);
  if (body.action === 'unlike') return await vote(body.id, -1);
  if (body.action === 'delete') return await remove(body);
  return reply(400, { error: '知らない操作です' });
}

async function create(body, event) {
  const png = String(body.png || '');

  if (!png.startsWith('data:image/png;base64,')) {
    return reply(400, { error: 'PNG の画像ではありません' });
  }
  if (png.length > MAX_PNG) {
    return reply(413, {
      error: '絵が重すぎて送れませんでした。ページを読み込み直してから、もう一度どうぞ',
    });
  }

  // 同じ相手からの連続投稿を断る。鍵には IP をそのまま使わず、
  // ハッシュにしてから入れる（生の IP は保存しない）。
  const ip   = event?.requestContext?.http?.sourceIp || 'unknown';
  const seat = 'rate#' + createHash('sha256').update(ip).digest('hex').slice(0, 24);
  const now  = Date.now();

  const seen = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: { id: { S: seat } },
    ProjectionExpression: 'expires',
  }));
  if (seen.Item && N(seen.Item.expires) * 1000 > now) {
    return reply(429, { error: '少し時間をおいてから、もう一度どうぞ' });
  }
  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      id:      { S: seat },
      expires: { N: String(Math.floor(now / 1000) + COOL_SEC) },
    },
  }));

  const id    = randomUUID();
  const token = randomUUID();          // 投稿した本人だけが消せるようにする鍵

  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      id:      { S: id },
      kind:    { S: 'post' },          // 一覧用の索引のまとめ役
      png:     { S: png },
      likes:   { N: '0' },
      created: { N: String(now) },
      token:   { S: createHash('sha256').update(token).digest('hex') },
      expires: { N: String(Math.floor(now / 1000) + KEEP_DAYS * 86400) },
    },
  }));

  return reply(201, { id, token, created: now, likes: 0 });
}

async function vote(id, delta) {
  if (!id) return reply(400, { error: 'どの投稿か分かりません' });
  try {
    const r = await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { id: { S: String(id) } },
      ConditionExpression: 'attribute_exists(id) AND kind = :k',
      UpdateExpression: 'SET likes = if_not_exists(likes, :zero) + :d',
      ExpressionAttributeValues: {
        ':d': { N: String(delta) }, ':zero': { N: '0' }, ':k': { S: 'post' },
      },
      ReturnValues: 'UPDATED_NEW',
    }));
    // 0 を下回らないように戻す
    let likes = N(r.Attributes?.likes);
    if (likes < 0) {
      await db.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { id: { S: String(id) } },
        UpdateExpression: 'SET likes = :zero',
        ExpressionAttributeValues: { ':zero': { N: '0' } },
      }));
      likes = 0;
    }
    return reply(200, { id, likes });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return reply(404, { error: 'その投稿は見つかりませんでした' });
    }
    throw e;
  }
}

async function remove(body) {
  const id    = String(body.id || '');
  const token = String(body.token || '');
  if (!id || !token) return reply(400, { error: '消すための鍵がありません' });

  const hash = createHash('sha256').update(token).digest('hex');
  try {
    await db.send(new DeleteItemCommand({
      TableName: TABLE,
      Key: { id: { S: id } },
      ConditionExpression: '#t = :h',
      ExpressionAttributeNames:  { '#t': 'token' },
      ExpressionAttributeValues: { ':h': { S: hash } },
    }));
    return reply(200, { ok: true });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return reply(403, { error: 'この投稿を消す権限がありません' });
    }
    throw e;
  }
}
