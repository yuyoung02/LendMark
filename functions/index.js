/*******************************************************
 * 0. 기본 의존성 & 초기화
 *******************************************************/
require("dotenv").config();
const { onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore"); // 추가됨
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const OpenAI = require("openai").default;

admin.initializeApp();

const REGION = "asia-northeast3";

/* ======================================================
   공통: 날짜 + 교시 → 시작/종료 Timestamp 계산
   ====================================================== */
function buildStartEndTimestamp(dateStr, periodStart, periodEnd) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const baseHour = 8;

  const startDate = new Date(year, month - 1, day, baseHour + periodStart, 0, 0);
  const endDate = new Date(year, month - 1, day, baseHour + periodEnd + 1, 0, 0);

  return {
    startAt: admin.firestore.Timestamp.fromDate(startDate),
    endAt: admin.firestore.Timestamp.fromDate(endDate),
  };
}


/*******************************************************
 * 1. 이메일 인증
 *******************************************************/
const gmailUser = process.env.GMAIL_USER;
const gmailPass = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: gmailUser, pass: gmailPass },
});

exports.sendVerificationCode = onCall({ region: "us-central1" }, async (req) => {
  const email = (req.data?.email || "").trim().toLowerCase();
  if (!email) throw new Error("Missing email");

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000;

  await admin.firestore()
    .collection("email_verifications")
    .doc(email)
    .set({ code, expiresAt });

  await transporter.sendMail({
    from: `"LendMark" <${gmailUser}>`,
    to: email,
    subject: "[LendMark] Email Authentication Code",
    html: `
      <div style="font-family:sans-serif;">
        <h2>Welcome to LendMark!</h2>
        <p>Please enter the authentication code below:</p>
        <h1 style="letter-spacing:4px;">${code}</h1>
        <p>Valid for 10 minutes.</p>
      </div>
    `,
  });

  return { ok: true };
});

exports.verifyEmailCode = onCall({ region: "us-central1" }, async (req) => {
  const email = (req.data?.email || "").trim().toLowerCase();
  const code = (req.data?.code || "").trim();

  const snap = await admin.firestore()
    .collection("email_verifications")
    .doc(email)
    .get();

  if (!snap.exists) return { ok: false, reason: "NOT_FOUND" };

  const { code: saved, expiresAt } = snap.data();
  if (Date.now() > expiresAt) return { ok: false, reason: "EXPIRED" };
  if (saved !== code) return { ok: false, reason: "INVALID" };

  await snap.ref.delete();
  return { ok: true };
});


/*******************************************************
 * 2. 예약 상태 자동 업데이트
 *******************************************************/

// 2-1 지난 예약 finished 처리 (30분마다 실행)
exports.finishPastReservations = onSchedule(
  { schedule: "every 30 minutes", region: REGION },
  async () => {
    const db = admin.firestore();
    const now = new Date();

    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;

    const snapshot = await db
      .collection("reservations")
      .where("status", "==", "approved")
      .get();

    const batch = db.batch();

    snapshot.forEach((doc) => {
      const r = doc.data();
      const dateStr = r.date;
      const endHour = 8 + (r.periodEnd + 1);

      if (dateStr < todayStr) {
        batch.update(doc.ref, { status: "finished" });
      } else if (dateStr === todayStr && now.getHours() >= endHour) {
        batch.update(doc.ref, { status: "finished" });
      }
    });

    await batch.commit();
    logger.info("finishPastReservations: done");
  }
);

// 2-2 finished 후 1주 지난 예약 expired 처리 (상태 변경용)
exports.expireOldReservations = onSchedule(
  { schedule: "every day 00:00", region: REGION },
  async () => {
    const db = admin.firestore();
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const snap = await db
      .collection("reservations")
      .where("status", "==", "finished")
      .where("timestamp", "<", oneWeekAgo)
      .get();

    const batch = db.batch();
    snap.forEach((doc) => batch.update(doc.ref, { status: "expired" }));
    await batch.commit();

    logger.info(`expireOldReservations: expired ${snap.size}`);
  }
);


/* ======================================================
   3. 예약 생성 (충돌 검사 + startAt/endAt + 알림 스케줄)
   ====================================================== */
exports.createReservation = onCall({ region: REGION }, async (req) => {
  console.log("REQ DATA =", req.data);
  const db = admin.firestore();

  const {
    userId, userName, major, people, purpose, buildingId, roomId, day,
    date, periodStart, periodEnd,
  } = req.data;

  /* 3-1. 시간 충돌 체크 */
  const snap = await db
    .collection("reservations")
    .where("buildingId", "==", buildingId)
    .where("roomId", "==", roomId)
    .where("date", "==", date)
    .where("status", "==", "approved")
    .get();

  for (const doc of snap.docs) {
    const r = doc.data();
    const s = r.periodStart;
    const e = r.periodEnd;
    const overlapped = !(periodEnd < s || periodStart > e);
    if (overlapped) return { success: false, reason: "TIME_CONFLICT" };
  }

  /* 3-2. startAt / endAt 계산 */
  const ps = Number(periodStart);
  const pe = Number(periodEnd);
  const { startAt, endAt } = buildStartEndTimestamp(date, ps, pe);

  /* 3-3. 예약 저장 */
  const newReservation = {
    userId, userName, major, people, purpose, buildingId, roomId, day, date,
    periodStart, periodEnd, startAt, endAt,
    timestamp: Date.now(),
    status: "approved",
  };
  const reservationRef = await db.collection("reservations").add(newReservation);

  /* 3-4. 유저 FCM 토큰 조회 */
  const userDoc = await db.collection("users").doc(userId).get();
  const fcmToken = userDoc.get("fcmToken");

  if (!fcmToken) {
    logger.warn(`createReservation: no fcmToken for user ${userId}`);
    return { success: true, warning: "NO_FCM_TOKEN" };
  }

  /* 3-5. 알림 시간 계산 */
  const startDate = startAt.toDate();
  const endDate = endAt.toDate();
  const startMinus30 = new Date(startDate.getTime() - 30 * 60 * 1000);
  const endMinus10 = new Date(endDate.getTime() - 10 * 60 * 1000);

  const sendAtStart = admin.firestore.Timestamp.fromDate(startMinus30);
  const sendAtEnd = admin.firestore.Timestamp.fromDate(endMinus10);

  /* 3-6. scheduled_notifications 스케줄 저장 */
  await db.collection("scheduled_notifications").add({
    userId, reservationId: reservationRef.id, token: fcmToken,
    title: "예약 시작 30분 전 알림",
    body: `${buildingId} ${roomId} 예약이 30분 뒤에 시작됩니다.`,
    sendAt: sendAtStart, sent: false, type: "start",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("scheduled_notifications").add({
    userId, reservationId: reservationRef.id, token: fcmToken,
    title: "예약 종료 10분 전 알림",
    body: `${buildingId} ${roomId} 예약 종료까지 10분 남았습니다.`,
    sendAt: sendAtEnd, sent: false, type: "end",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});


/*******************************************************
 * 5. AI 강의실 추천
 *******************************************************/
exports.chatbotAvailableRoomsV2 = onCall({ region: REGION }, async (req) => {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { buildingId, buildingName, date, hour } = req.data;
    if (!buildingId || !buildingName || !date || hour === undefined) throw new Error("Missing required fields");

    const db = admin.firestore();
    const targetPeriod = hour - 8;
    const dayCode = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(date).getDay()];

    const buildingDoc = await db.collection("buildings").doc(buildingId).get();
    const timetable = buildingDoc.get("timetable") ?? {};

    const reservationSnap = await db.collection("reservations")
      .where("buildingId", "==", buildingId)
      .where("date", "==", date)
      .where("status", "==", "approved")
      .get();
    const reservations = reservationSnap.docs.map((d) => d.data());

    function isAvailable(roomId, roomData) {
      for (const ev of roomData?.schedule ?? []) {
        if (ev.day === dayCode) {
          if (!(targetPeriod < ev.periodStart || targetPeriod > ev.periodEnd)) return false;
        }
      }
      for (const r of reservations) {
        if (r.roomId === roomId) {
          if (!(targetPeriod < r.periodStart || targetPeriod > r.periodEnd)) return false;
        }
      }
      return true;
    }

    const availableRooms = Object.entries(timetable)
      .filter(([roomId, roomData]) => isAvailable(roomId, roomData))
      .map(([roomId]) => roomId);

    const prettyList = availableRooms.length > 0 ? availableRooms.map((r) => `- ${r}`).join("\n") : "없음";
    const prompt = `날짜: ${date}\n시간: ${hour}시\n건물: ${buildingName}\n가능한 강의실 목록:\n${prettyList}\n학생이 이해하기 쉽게 자연스럽게 설명해줘.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    return { ok: true, answer: completion.choices[0].message.content, rooms: availableRooms };
  } catch (err) {
    logger.error(err);
    return { ok: false, error: err.message };
  }
});


/* ======================================================
   6. 스케줄러: 1분마다 돌면서 예약 알림 발송 (Cron Job)
   ====================================================== */
exports.sendScheduledNotifications = onSchedule(
  { schedule: "every 1 minutes", region: REGION },
  async (event) => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    const snapshot = await db.collection("scheduled_notifications")
      .where("sent", "==", false)
      .where("sendAt", "<=", now)
      .get();

    if (snapshot.empty) return;

    const promises = [];
    const batch = db.batch();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const message = {
        token: data.token,
        notification: { title: data.title, body: data.body },
        data: { reservationId: data.reservationId || "" },
      };

      const sendPromise = admin.messaging().send(message)
        .then(() => {
          logger.info(`Notification sent to ${doc.id}`);
          batch.update(doc.ref, { sent: true, sentAt: admin.firestore.FieldValue.serverTimestamp() });
        })
        .catch((err) => {
          logger.error(`Failed to send to ${doc.id}:`, err);
        });
      promises.push(sendPromise);
    });

    await Promise.all(promises);
    await batch.commit();
    logger.info(`Processed ${snapshot.size} notifications.`);
  }
);


/* ======================================================
   7. 예약 감지 트리거 (한국 시간 KST + 건물명 표시)
   ====================================================== */
exports.onReservationCreated = onDocumentCreated(
    { document: "reservations/{reservationId}", region: REGION },
    async (event) => {
    const reservation = event.data.data();
    const reservationId = event.params.reservationId;
    const db = admin.firestore();

    const { userId, buildingId, roomId, date, periodStart, periodEnd } = reservation;
    if (!userId || !date) return;

    // 1. 유저 토큰 찾기
    const userDoc = await db.collection("users").doc(userId).get();
    const fcmToken = userDoc.get("fcmToken");
    if (!fcmToken) return;

    // 2. 건물 이름 찾기
    const buildingDoc = await db.collection("buildings").doc(buildingId).get();
    const buildingName = buildingDoc.exists ? (buildingDoc.data().name || buildingId) : buildingId;

    // 3. 한국 시간 보정
    function getKstDate(dateStr, hour) {
        const [year, month, day] = dateStr.split("-").map(Number);
        const dateObj = new Date(year, month - 1, day, hour, 0, 0);
        dateObj.setHours(dateObj.getHours() - 9);
        return dateObj;
    }

    const baseHour = 8;
    const startDate = getKstDate(date, baseHour + Number(periodStart));
    const endDate = getKstDate(date, baseHour + Number(periodEnd) + 1);

    const startMinus30 = new Date(startDate.getTime() - 30 * 60 * 1000);
    const endMinus10 = new Date(endDate.getTime() - 10 * 60 * 1000);

    // 4. 알림 저장
    const batch = db.batch();

    batch.set(db.collection("scheduled_notifications").doc(), {
        userId, reservationId, token: fcmToken,
        title: "예약 시작 30분 전 알림",
        body: `${buildingName} ${roomId}호 예약이 30분 뒤에 시작됩니다.`,
        sendAt: admin.firestore.Timestamp.fromDate(startMinus30),
        sent: false, type: "start",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(db.collection("scheduled_notifications").doc(), {
        userId, reservationId, token: fcmToken,
        title: "예약 종료 10분 전 알림",
        body: `${buildingName} ${roomId}호 예약 종료까지 10분 남았습니다.`,
        sendAt: admin.firestore.Timestamp.fromDate(endMinus10),
        sent: false, type: "end",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
});


/* ======================================================
   8. [NEW] 데이터 완전 삭제 (매일 자정 실행)
   ====================================================== */
exports.dailyCleanup = onSchedule(
  { schedule: "every day 00:00", region: REGION },
  async (event) => {
    const db = admin.firestore();
    const now = Date.now();
    const DAY_IN_MS = 24 * 60 * 60 * 1000;
    const retentionPeriod = 7 * DAY_IN_MS; // 7일

    // 기준 시간: 지금으로부터 7일 전
    const cutoffTimestamp = now - retentionPeriod;
    const cutoffDate = admin.firestore.Timestamp.fromMillis(cutoffTimestamp);

    const batch = db.batch();
    let deleteCount = 0;

    try {
        // 8-1. 7일 지난 예약 완전 삭제 (timestamp 기준)
        const oldReservations = await db.collection('reservations')
            .where('timestamp', '<', cutoffTimestamp)
            .get();

        oldReservations.forEach(doc => {
            batch.delete(doc.ref);
            deleteCount++;
        });

        // 8-2. 7일 지난 발송 완료된 알림 삭제 (sendAt 기준)
        const oldNotifications = await db.collection('scheduled_notifications')
            .where('sent', '==', true)
            .where('sendAt', '<', cutoffDate)
            .get();

        oldNotifications.forEach(doc => {
            batch.delete(doc.ref);
            deleteCount++;
        });

        if (deleteCount > 0) {
            await batch.commit();
            logger.info(`dailyCleanup: Deleted ${deleteCount} old documents.`);
        } else {
            logger.info("dailyCleanup: No documents to delete.");
        }

    } catch (error) {
        logger.error("dailyCleanup Error:", error);
    }
  }
);