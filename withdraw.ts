import type { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";
import admin from "firebase-admin";

// ─── Firebase Init (Vercel env vars se) ──────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// ─── Gateway Config ───────────────────────────────────
const GATEWAY_TOKEN = "UFCJYD2Q";
const GATEWAY_KEY = "WvNnEmlFhpfpW5JX";
const GATEWAY_BASE = "https://gateway-js-lbuc.vercel.app/api/gateway";

// ─── Main Handler ─────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET + POST dono support
  const params = { ...req.query, ...req.body } as Record<string, string>;
  const { token, key, number, paytoNumber, amount } = params;
  const targetNumber = paytoNumber || number;

  // ── Validation ──
  if (!token || !key || !targetNumber || !amount) {
    return res.status(400).json({
      status: "error",
      message: "Required: token, key, number, amount",
    });
  }

  const withdrawAmount = parseFloat(amount);
  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ status: "error", message: "Invalid amount" });
  }

  try {
    // ── Step 1: Token + Key se user dhundo ──
    const userQuery = await db
      .collection("users")
      .where("apiToken", "==", token)
      .where("apiKey", "==", key)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return res.status(401).json({ status: "error", message: "Invalid token or key" });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();
    const currentBalance = userData?.balance || 0;

    // ── Step 2: Balance check ──
    if (currentBalance < withdrawAmount) {
      return res.status(400).json({
        status: "error",
        message: `Insufficient balance. Available: ₹${currentBalance}`,
      });
    }

    // ── Step 3: Balance hold (deduct) ──
    await userDoc.ref.update({
      balance: admin.firestore.FieldValue.increment(-withdrawAmount),
    });

    // ── Step 4: Gateway call ──
    const gatewayUrl =
      `${GATEWAY_BASE}?token=${GATEWAY_TOKEN}` +
      `&key=${GATEWAY_KEY}` +
      `&number=${encodeURIComponent(targetNumber)}` +
      `&amount=${withdrawAmount}`;

    let gatewayResponse: any;
    try {
      const response = await axios.get(gatewayUrl, { timeout: 15000 });
      gatewayResponse = response.data;
    } catch (err: any) {
      // Gateway fail — balance restore karo
      await userDoc.ref.update({
        balance: admin.firestore.FieldValue.increment(withdrawAmount),
      });
      return res.status(502).json({
        status: "error",
        message: "Gateway connection failed, balance restored",
      });
    }

    // ── Step 5: Gateway response check ──
    const isSuccess =
      gatewayResponse?.status === "success" ||
      gatewayResponse?.success === true ||
      gatewayResponse?.code === 200;

    if (!isSuccess) {
      // Gateway rejected — balance restore karo
      await userDoc.ref.update({
        balance: admin.firestore.FieldValue.increment(withdrawAmount),
      });
      return res.status(400).json({
        status: "error",
        message: gatewayResponse?.message || "Gateway rejected payment",
      });
    }

    // ── Step 6: Transaction log ──
    const txRef = await db.collection("transactions").add({
      userId: userDoc.id,
      type: "withdraw",
      status: "completed",
      amount: withdrawAmount,
      mobileNumber: targetNumber,
      description: `API Withdrawal to ${targetNumber}`,
      gatewayRef: gatewayResponse?.transactionId || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      status: "success",
      message: `✅ ₹${withdrawAmount} sent to ${targetNumber}`,
      transactionId: txRef.id,
      gatewayRef: gatewayResponse?.transactionId || null,
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
}
