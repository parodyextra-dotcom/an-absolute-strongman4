// ==========================================
// 절대강자 분할환전 - Service Worker
// 목표매수환율 도달 시 30초 간격 백그라운드 알림
// ==========================================

const CACHE_NAME = 'fx-alarm-v1';
const CHECK_INTERVAL = 30000; // 30초
const API_URL = 'https://api.exchangerate-api.com/v4/latest/KRW';

let alarmInterval = null;
let isAlarmActive = false;

// Install event
self.addEventListener('install', (event) => {
  self.skipWaiting();
  console.log('[SW] Installed');
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  console.log('[SW] Activated');
});

// Listen for messages from main page
self.addEventListener('message', (event) => {
  const { type, data } = event.data;
  
  if (type === 'START_ALARM_CHECK') {
    // data: { targets: { USD: 1380, JPY: 920.5, EUR: 1500, CNY: 190 }, rates: { USD: ..., JPY: ..., EUR: ..., CNY: ... } }
    startAlarmCheck(data);
  } else if (type === 'STOP_ALARM_CHECK') {
    stopAlarmCheck();
  } else if (type === 'UPDATE_TARGETS') {
    // Update targets without restart
    if (self.alarmData) {
      self.alarmData.targets = data.targets;
    }
  } else if (type === 'DISMISS_ALARM') {
    // User dismissed the alarm for a specific currency
    if (self.alarmData && self.alarmData.dismissedCurrencies) {
      self.alarmData.dismissedCurrencies.add(data.currency);
    }
  }
});

function startAlarmCheck(data) {
  // Store alarm data
  self.alarmData = {
    targets: data.targets || {},
    dismissedCurrencies: new Set()
  };
  
  isAlarmActive = true;
  
  // Clear previous interval
  if (alarmInterval) {
    clearInterval(alarmInterval);
  }
  
  // Start checking immediately and then every 30 seconds
  checkRatesAndNotify();
  alarmInterval = setInterval(checkRatesAndNotify, CHECK_INTERVAL);
  
  console.log('[SW] Alarm check started with targets:', data.targets);
}

function stopAlarmCheck() {
  isAlarmActive = false;
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
  self.alarmData = null;
  console.log('[SW] Alarm check stopped');
}

async function checkRatesAndNotify() {
  if (!isAlarmActive || !self.alarmData) return;
  
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    
    if (!data.rates) return;
    
    // Calculate KRW-based rates
    const currentRates = {};
    if (data.rates.USD) currentRates.USD = Math.round((1 / data.rates.USD) * 10) / 10;
    if (data.rates.JPY) currentRates.JPY = Math.round((100 / data.rates.JPY) * 100) / 100;
    if (data.rates.EUR) currentRates.EUR = Math.round((1 / data.rates.EUR) * 100) / 100;
    if (data.rates.CNY) currentRates.CNY = Math.round((1 / data.rates.CNY) * 100) / 100;
    
    const targets = self.alarmData.targets;
    const dismissed = self.alarmData.dismissedCurrencies;
    
    const CURRENCY_NAMES = {
      USD: '미국 달러',
      JPY: '일본 엔화(100엔)',
      EUR: '유로',
      CNY: '중국 위안'
    };
    const CURRENCY_FLAGS = {
      USD: '🇺🇸',
      JPY: '🇯🇵',
      EUR: '🇪🇺',
      CNY: '🇨🇳'
    };
    
    let triggeredCurrencies = [];
    
    for (const cur of ['USD', 'JPY', 'EUR', 'CNY']) {
      const target = targets[cur];
      const current = currentRates[cur];
      
      if (target && current && current <= target && !dismissed.has(cur)) {
        triggeredCurrencies.push({
          currency: cur,
          name: CURRENCY_NAMES[cur],
          flag: CURRENCY_FLAGS[cur],
          current: current,
          target: target,
          diff: (target - current).toFixed(cur === 'USD' ? 1 : 2)
        });
      }
    }
    
    if (triggeredCurrencies.length > 0) {
      // Send notification
      const title = '🔔 목표 매수환율 도달!';
      let body = triggeredCurrencies.map(t => 
        `${t.flag} ${t.name}: ${t.current}원 (목표: ${t.target}원, -${t.diff}원)`
      ).join('\n');
      
      try {
        await self.registration.showNotification(title, {
          body: body,
          icon: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27%3E%3Ctext y=%27.9em%27 font-size=%2790%27%3E💰%3C/text%3E%3C/svg%3E',
          badge: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27%3E%3Ctext y=%27.9em%27 font-size=%2790%27%3E💰%3C/text%3E%3C/svg%3E',
          tag: 'fx-target-alarm',
          renotify: true,
          requireInteraction: true,
          vibrate: [200, 100, 200, 100, 200],
          data: { triggeredCurrencies },
          actions: [
            { action: 'open', title: '앱 열기' },
            { action: 'dismiss', title: '알림 끄기' }
          ]
        });
      } catch (e) {
        console.error('[SW] Notification error:', e);
      }
      
      // Also notify the main page (if open)
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: 'ALARM_TRIGGERED',
          data: { triggeredCurrencies, currentRates }
        });
      }
    } else {
      // Even if no alarm, send rate update to open clients
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: 'RATE_UPDATE',
          data: { currentRates }
        });
      }
    }
    
  } catch (e) {
    console.error('[SW] Rate check error:', e);
  }
}

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.action === 'dismiss') {
    // Dismiss all currency alarms
    if (self.alarmData) {
      const currencies = event.notification.data?.triggeredCurrencies || [];
      currencies.forEach(t => {
        self.alarmData.dismissedCurrencies.add(t.currency);
      });
    }
    return;
  }
  
  // Open or focus the app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('index.html') || client.url.endsWith('/')) {
          return client.focus();
        }
      }
      return self.clients.openWindow('./');
    })
  );
});

// Handle notification close
self.addEventListener('notificationclose', (event) => {
  // Keep alarm running - user just closed the notification
  console.log('[SW] Notification closed, alarm continues');
});
