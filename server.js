const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const webPush = require('web-push');
const axios = require('axios');
const path = require('path');

// WebSocket サーバーのエンドポイント
const wsUrl = 'wss://api.p2pquake.net/v2/ws';
const eewWsUrl = 'wss://ws-api.wolfx.jp/jma_eew';

// WebSocket 再接続の間隔（ミリ秒）
const reconnectInterval = 1000;

// 環境変数 PORT からポートを取得（Render の要件）
const PORT = process.env.PORT || 3000;

// 管理者メッセージを保存するためのメモリ内ストレージ
let adminMessage = {
  text: '',
  isVisible: false,
  type: 'info', // 'info', 'warning', 'error'
  timestamp: null
};

// 通知許可リストとアクセス履歴をメモリ内で管理
let subscriptions = [];
let accessHistory = new Set(); // IPアドレスやセッションIDを記録
let autoSubscriptionEnabled = true; // 自動通知許可機能のフラグ

// VAPID keys for web push notifications
const vapidKeys = {
  publicKey: 'BC1T1-o4f9vLJ11ngQXOZTdKY8xd38vUyWeWyPosJ7JDJxnCPrAGtJZE_CUW4dqdh60eEUf5G-qzWjaojsSMer0',
  privateKey: 'ya3LjwPTzOVTnLaz5S5qrtPne7I_C_tAEr60jzEQZAY'
};

webPush.setVapidDetails(
  'mailto:example@yourdomain.org',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const app = express();
app.use(bodyParser.json());

// HTTP サーバーを作成して Render が要求するポートをリッスン
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`HTTP server is running on port ${PORT}`);
});

// 初回アクセス判定とアクセス履歴記録のミドルウェア
app.use((req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
  const userAgent = req.headers['user-agent'];
  const clientId = `${clientIP}-${userAgent}`;
  
  // 初回アクセスかどうかを判定
  req.isFirstAccess = !accessHistory.has(clientId);
  
  // アクセス履歴に記録
  accessHistory.add(clientId);
  
  next();
});

// 初回アクセス判定API
app.get('/api/first-access', (req, res) => {
  res.json({ 
    isFirstAccess: req.isFirstAccess,
    autoSubscriptionEnabled: autoSubscriptionEnabled
  });
});

// 管理者メッセージを設定するAPI
app.post('/api/admin-message', (req, res) => {
  const adminKey = req.query.key;
  
  // 簡易的な認証
  if (adminKey !== '0429') {
    return res.status(401).json({ error: '認証に失敗しました' });
  }
  
  const { text, isVisible, type } = req.body;
  
  adminMessage = {
    text: text || '',
    isVisible: isVisible !== undefined ? isVisible : false,
    type: type || 'info',
    timestamp: new Date().toISOString()
  };
  
  console.log('Admin message updated:', adminMessage);
  res.status(200).json({ success: true, message: adminMessage });
});

// 管理者メッセージを取得するAPI（認証不要 - 公開情報）
app.get('/api/admin-message', (req, res) => {
  // 表示設定がtrueの場合のみメッセージを返す
  if (adminMessage.isVisible && adminMessage.text) {
    res.status(200).json(adminMessage);
  } else {
    res.status(200).json({ isVisible: false });
  }
});

// 管理者メッセージを取得するAPI（管理者用 - 認証必要）
app.get('/api/admin-message-full', (req, res) => {
  const adminKey = req.query.key;
  
  if (adminKey !== '0429') {
    return res.status(401).json({ error: '認証に失敗しました' });
  }
  
  res.status(200).json(adminMessage);
});

// 自動通知許可設定API（管理者用）
app.post('/api/auto-subscription', (req, res) => {
  const adminKey = req.query.key;
  
  if (adminKey !== '0429') {
    return res.status(401).json({ error: '認証に失敗しました' });
  }
  
  const { enabled } = req.body;
  autoSubscriptionEnabled = enabled !== undefined ? enabled : true;
  
  console.log('Auto subscription setting updated:', autoSubscriptionEnabled);
  res.status(200).json({ success: true, autoSubscriptionEnabled });
});

// 管理者ページを提供
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

let ws;
function connectWebSocket() {
  console.log('Connecting to WebSocket server...');
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('WebSocket connection established');
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      console.log("Received Data:", message);

      if (message.code === 551) {
        console.log('Processing earthquake data with code 551.');
        if (!message.earthquake) {
          console.error("Invalid earthquake data received.");
          return;
        }

        const earthquakeInfo = formatEarthquakeInfo(message.earthquake, message);
        sendWebPushNotification(earthquakeInfo);
      } else if (message.code === 552) {
        console.log('Processing tsunami warning data with code 552.');
        const tsunamiInfo = formatTsunamiWarningInfo(message);
        sendWebPushNotification(tsunamiInfo);
        sendLineBroadcast(tsunamiInfo);
      } else {
        console.log(`Ignored message with code: ${message.code}`);
      }
    } catch (error) {
      console.error("Error processing message data:", error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed. Reconnecting in 5 seconds...');
    setTimeout(connectWebSocket, reconnectInterval);
  });
}

// Connect to emergency earthquake alert WebSocket
let eewWs;
function connectEewWebSocket() {
  console.log('Connecting to EEW WebSocket server...');
  eewWs = new WebSocket(eewWsUrl);

  eewWs.on('open', () => {
    console.log('EEW WebSocket connection established');
  });

  eewWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      console.log("Received EEW Data:", message);

      if (message.Title && message.CodeType) {
        let formattedMessage;
        if (message.isCancel) {
          formattedMessage = "先程の緊急地震速報は取り消されました。";
        } else {
          formattedMessage = formatEewMessage(message);
          if (message.isAssumption) {
            formattedMessage += "\n※この緊急地震速報は精度が低い可能性があります※";
          }
        }
        sendWebPushNotification(formattedMessage);
      }
    } catch (error) {
      console.error("Error processing EEW message data:", error);
    }
  });

  eewWs.on('error', (error) => {
    console.error('EEW WebSocket error:', error);
  });

  eewWs.on('close', () => {
    console.log('EEW WebSocket connection closed. Reconnecting in 5 seconds...');
    setTimeout(connectEewWebSocket, reconnectInterval);
  });
}

function formatEewMessage(data) {
  return `【${data.Title} 推定最大震度${data.MaxIntensity}】\n(第${data.Serial}報)\n${data.OriginTime.split(' ')[1]}頃、${data.Hypocenter}を震源とする地震がありました。地震の規模はM${data.Magunitude}程度、震源の深さは約${data.Depth}km、最大震度${data.MaxIntensity}程度と推定されています。`;
}

function formatEarthquakeInfo(earthquake, message) {
  const time = new Date(earthquake.time);
  const date = time.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' });
  const timeStr = time.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

  const hypocenter = earthquake.hypocenter.name;
  const maxScale = getScaleDescription(earthquake.maxScale);
  let magnitude = earthquake.hypocenter.magnitude;
  let depth = earthquake.hypocenter.depth;

  depth = depth === -1 ? '不明' : depth === 0 ? 'ごく浅い' : `約${depth}km`;
  magnitude = magnitude === -1 ? '不明' : magnitude.toFixed(1);

  const pointsByScale = groupPointsByScale(message.points);
  const tsunamiInfo = getTsunamiInfo(earthquake.domesticTsunami);
  const freeFormComment = message.comments?.freeFormComment || '';

  // 震度速報のフォーマット
  if (message.issue && message.issue.type === 'ScalePrompt') {
    let formattedMessage = `[震度速報]\n${date} ${timeStr}ころ、地震による強い揺れを感じました。震度３以上が観測された地域をお知らせします。\n`;

    Object.keys(pointsByScale).sort((a, b) => b - a).forEach(scale => {
      formattedMessage += `\n《震度${scale}》`;
      Object.keys(pointsByScale[scale]).forEach(pref => {
        formattedMessage += `\n【${pref}】${pointsByScale[scale][pref].join('  ')}`;
      });
    });

    return formattedMessage;
  }

  // 通常の地震情報のフォーマット
  let formattedMessage = `[地震情報]\n${date} ${timeStr}頃\n震源地：${hypocenter}\n最大震度：${maxScale}\n深さ：${depth}\n規模：M${magnitude}\n${tsunamiInfo}\n\n［各地の震度］`;

  // 震度順序を定義
  const scaleOrder = ['7', '6強', '6弱', '5強', '5弱', '4', '3', '2', '1'];

  // 震度順にソート
  const sortedScales = Object.keys(pointsByScale).sort((a, b) => {
    return scaleOrder.indexOf(a) - scaleOrder.indexOf(b);
  });

  sortedScales.forEach(scale => {
    formattedMessage += `\n《震度${scale}》`;
    Object.keys(pointsByScale[scale]).forEach(pref => {
      const uniqueCities = new Set();
      pointsByScale[scale][pref].forEach(addr => {
        // 市区町村名を抽出してセットに追加
        const cityMatch = addr.match(/([^市区町村]+[市区町村])/);
        if (cityMatch) {
          uniqueCities.add(cityMatch[1]);
        }
      });
      // 市区町村のみを表示
      formattedMessage += `\n【${pref}】${Array.from(uniqueCities).join('  ')}`;
    });
  });

  if (freeFormComment) {
    formattedMessage += `\n\n【情報】\n${freeFormComment}`;
  }

  return formattedMessage;
}

function groupPointsByScale(points) {
  const pointsByScale = {};
  points.forEach(point => {
    const scale = getScaleDescription(point.scale);
    const addr = point.addr;
    const prefecture = point.pref;

    if (!scale) return;

    pointsByScale[scale] = pointsByScale[scale] || {};
    pointsByScale[scale][prefecture] = pointsByScale[scale][prefecture] || [];
    pointsByScale[scale][prefecture].push(addr);
  });
  return pointsByScale;
}

function getScaleDescription(scale) {
  const scaleDescriptions = {
    10: '1',
    20: '2',
    30: '3',
    40: '4',
    45: '5弱',
    50: '5強',
    55: '6弱',
    60: '6強',
    70: '7'
  };
  return scaleDescriptions[scale] || '不明';
}

function getTsunamiInfo(domesticTsunami) {
  const tsunamiMessages = {
    "None": "この地震による津波の心配はありません。",
    "Unknown": "不明",
    "Checking": "津波の有無を調査中です。今後の情報に注意してください。",
    "NonEffective": "若干の海面変動があるかもしれませんが、被害の心配はありません。",
    "Watch": "現在、津波注意報を発表中です。",
    "Warning": "津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。"
  };
  return tsunamiMessages[domesticTsunami] || "（津波情報なし）";
}

function formatTsunamiWarningInfo(message) {
  if (message.cancelled) {
    return "津波警報等（大津波警報・津波警報あるいは津波注意報）は解除されました。";
  }

  // 津波警報の種類に応じてメッセージを作成
  const warnings = {
    MajorWarning: '【大津波警報🟪】\n大津波警報を発表しました！\n今すぐ高台やビルに避難！！\n【対象地域】',
    Warning: '【津波警報🟥】\n津波警報を発表しています！\n高台や近くのビルへ避難！\n【対象地域】',
    Watch: '【津波注意報🟨】\n津波注意報を発表しています。\n海や川から離れて下さい！\n【対象地域】',
    Unknown: '【津波情報❓️】\n津波の状況は不明です。\n今後の情報に注意してください。\n※プログラムエラーの可能性大。開発者をメンションして下さい。'
  };

  let formattedMessage = warnings[message.areas[0].grade] || '【津波情報】\n津波の状況が不明です。\n【対象地域】';

  const areas = message.areas.map(area => {
    const name = area.name;
    const maxHeight = area.maxHeight.description;

    return `［${name}］${maxHeight}`;
  }).join('\n');

  formattedMessage += `\n${areas}\n津波は１mでも人や物を押し倒します！`;

  if (message.areas[0].grade === 'MajorWarning') {
    formattedMessage += `\n⚠️絶対に避難⚠️`;
  }

  return formattedMessage;
}

function sendWebPushNotification(message) {
  const payload = JSON.stringify({ title: '地震情報', body: message });

  subscriptions.forEach(subscription => {
    webPush.sendNotification(subscription, payload).catch(error => {
      console.error('Error sending notification, reason: ', error);
    });
  });
}

async function sendLineBroadcast(message) {
  const token = 'phHkJycfaMjHVXDcir9/eIdPV8uVhEsaqcosdBo53JxJtr2D2n+yrvUbe8aSiKGFXmwHEH1O0w+B5MwHGxq28G6R6kTkqrWPA/siv6vLWC/mxGBKYXIvB76n41taoa3fqOou9/vShToLAKaUG+tQFVAdB04t89/1O/w1cDnyilFU=';
  const url = 'https://api.line.me/v2/bot/message/broadcast';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
  const body = {
    messages: [
      {
        type: 'text',
        text: message
      }
    ]
  };

  try {
    const response = await axios.post(url, body, { headers });
    console.log('Message sent to LINE Broadcast:', response.data);
  } catch (error) {
    console.error('Error sending message to LINE Broadcast:', error);
  }
}

connectWebSocket();
connectEewWebSocket();

// Web Push notification subscription endpoint
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  subscriptions.push(subscription);
  console.log('New subscription added. Total subscriptions:', subscriptions.length);
  res.status(201).json({});
});

// Test notification endpoint
app.post('/test-notification', (req, res) => {
  const testMessage = 'これはお試し通知のメッセージです。';
  sendWebPushNotification(testMessage);
  res.status(201).json({});
});

// Serve static files (for PWA)
app.use(express.static('public'));