require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.send("Backend is running");
});

/* ================= DATABASE ================= */

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

/* ================= ADMIN LOGIN ================= */

app.post("/admin/login", (req, res) => {
    const { username, password } = req.body;

    if (
        username !== process.env.ADMIN_USER ||
        password !== process.env.ADMIN_PASS
    ) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
        { role: "admin" },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
    );

    res.json({ token });
});

/* ================= ADMIN AUTH ================= */

function verifyAdmin(req, res, next) {

    const authHeader = req.headers.authorization;

    if (!authHeader)
        return res.status(403).json({ error: "No token provided" });

    const token = authHeader.split(" ")[1];

    try {
        jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(403).json({ error: "Invalid or expired token" });
    }

}

/* ================= MEMBER LOGIN ================= */

app.post("/member-login", async (req, res) => {

    const { phone } = req.body;

    try {

        const result = await pool.query(
            "SELECT * FROM members WHERE phone=$1",
            [phone]
        );

        if (result.rows.length === 0)
            return res.status(404).json({ error: "Member not found" });

        res.json(result.rows[0]);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }

});

/* ================= ADD MEMBER ================= */

app.post("/admin/add-member", verifyAdmin, async (req, res) => {

    const { name, phone, membership_start, membership_expiry } = req.body;

    try {

        const result = await pool.query(
            `INSERT INTO members
       (name, phone, membership_start, membership_expiry)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
            [name, phone, membership_start, membership_expiry]
        );

        res.json(result.rows[0]);

    } catch (err) {
        res.status(400).json({ error: "Phone already exists or invalid data" });
    }

});

/* ================= ADD BOOK ================= */

app.post("/admin/add-book", verifyAdmin, async (req, res) => {

    const { title, author, barcode } = req.body;

    try {

        const result = await pool.query(
            `INSERT INTO books
       (title, author, barcode)
       VALUES ($1,$2,$3)
       RETURNING *`,
            [title, author, barcode]
        );

        res.json(result.rows[0]);

    } catch (err) {
        res.status(400).json({ error: "Barcode already exists" });
    }

});

/* ================= SCAN BOOK ================= */

app.post("/scan", async (req, res) => {

    const { member_id, barcode } = req.body;

    try {

        const today = new Date();

        const memberRes = await pool.query(
            "SELECT * FROM members WHERE id=$1",
            [member_id]
        );

        if (memberRes.rows.length === 0)
            return res.status(400).json({ error: "Invalid member" });

        const member = memberRes.rows[0];

        if (new Date(member.membership_expiry) < today)
            return res.status(400).json({ error: "Membership expired" });

        const bookRes = await pool.query(
            "SELECT * FROM books WHERE barcode=$1",
            [barcode]
        );

        if (bookRes.rows.length === 0)
            return res.status(400).json({ error: "Book not found" });

        const book = bookRes.rows[0];

        if (book.status === "available") {

            const dueDate = new Date();
            dueDate.setDate(today.getDate() + 14);

            await pool.query(
                "UPDATE books SET status='issued' WHERE id=$1",
                [book.id]
            );

            await pool.query(
                `INSERT INTO transactions
         (member_id, book_id, issue_date, due_date, status)
         VALUES ($1,$2,$3,$4,'issued')`,
                [member.id, book.id, today, dueDate]
            );

            return res.json({ message: "Book issued successfully" });

        }

        if (book.status === "issued") {

            const transRes = await pool.query(
                `SELECT * FROM transactions
         WHERE book_id=$1 AND status='issued'`,
                [book.id]
            );

            const transaction = transRes.rows[0];

            if (!transaction)
                return res.status(400).json({ error: "Transaction not found" });

            if (transaction.member_id !== member.id)
                return res.status(400).json({
                    error: "Book issued to another member",
                });

            let fine = 0;

            if (today > transaction.due_date) {

                const daysLate = Math.ceil(
                    (today - transaction.due_date) / (1000 * 60 * 60 * 24)
                );

                fine = daysLate * 5;

            }

            await pool.query(
                `UPDATE transactions
         SET return_date=$1, fine=$2, status='returned'
         WHERE id=$3`,
                [today, fine, transaction.id]
            );

            await pool.query(
                "UPDATE books SET status='available' WHERE id=$1",
                [book.id]
            );

            return res.json({
                message: "Book returned successfully",
                fine,
            });

        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }

});

/* ================= ADMIN VIEW ================= */

app.get("/admin/members", verifyAdmin, async (req, res) => {

    const result = await pool.query(
        "SELECT * FROM members ORDER BY id DESC"
    );

    res.json(result.rows);

});

app.get("/admin/books", verifyAdmin, async (req, res) => {

    const result = await pool.query(
        "SELECT * FROM books ORDER BY id DESC"
    );

    res.json(result.rows);

});

app.get("/admin/transactions", verifyAdmin, async (req, res) => {

    const result = await pool.query(`
    SELECT t.*, 
           m.name AS member_name, 
           b.title AS book_title
    FROM transactions t
    JOIN members m ON t.member_id = m.id
    JOIN books b ON t.book_id = b.id
    ORDER BY t.id DESC
  `);

    res.json(result.rows);

});

/* ================= RENEW REQUEST ================= */

app.post("/renew-request", async (req, res) => {

    const { member_id, transaction_id } = req.body;

    if (!member_id || !transaction_id)
        return res.status(400).json({ error: "Missing data" });

    try {

        const pending = await pool.query(
            "SELECT * FROM renew_requests WHERE member_id=$1 AND status='pending'",
            [member_id]
        );

        if (pending.rows.length > 0)
            return res.status(400).json({ error: "Renewal already requested" });

        const existing = await pool.query(
            "SELECT * FROM renew_requests WHERE transaction_id=$1",
            [transaction_id]
        );

        if (existing.rows.length > 0)
            return res.status(400).json({ error: "Transaction already used" });

        await pool.query(
            "INSERT INTO renew_requests (member_id, transaction_id) VALUES ($1,$2)",
            [member_id, transaction_id]
        );

        res.json({ message: "Renewal request submitted" });

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Server error" });

    }

});

/* ================= ADMIN RENEW CONTROL ================= */

app.get("/admin/renew-requests", verifyAdmin, async (req, res) => {

    try {

        const result = await pool.query(`
      SELECT 
        r.id,
        r.transaction_id,
        r.status,
        r.member_id,
        m.name
      FROM renew_requests r
      LEFT JOIN members m 
      ON m.id = r.member_id
      ORDER BY r.created_at DESC
    `);

        res.json(result.rows);

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Server error" });

    }

});

app.post("/admin/approve-renewal/:id", verifyAdmin, async (req, res) => {

    const requestId = req.params.id;

    try {

        const request = await pool.query(
            "SELECT member_id FROM renew_requests WHERE id=$1",
            [requestId]
        );

        if (request.rows.length === 0)
            return res.status(404).json({ error: "Request not found" });

        const memberId = request.rows[0].member_id;

        await pool.query(`
      UPDATE members
      SET membership_expiry = CURRENT_DATE + INTERVAL '1 year'
      WHERE id=$1
    `, [memberId]);

        await pool.query(`
      UPDATE renew_requests
      SET status='approved'
      WHERE id=$1
    `, [requestId]);

        res.json({ message: "Membership renewed successfully" });

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Server error" });

    }

});
app.get("/books", async (req, res) => {
    try {

        const result = await pool.query(
            "SELECT id,title,author,barcode,status FROM books ORDER BY id DESC"
        );

        res.json(result.rows);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= MEMBER BORROWED BOOKS ================= */

app.get("/member/:id/books", async (req, res) => {

    try {

        const result = await pool.query(
            `SELECT 
                t.id,
                b.title,
                b.author,
                t.issue_date,
                t.due_date
            FROM transactions t
            JOIN books b ON t.book_id = b.id
            WHERE t.member_id = $1
            AND t.status = 'issued'
            ORDER BY t.issue_date DESC`,
            [req.params.id]
        );

        res.json(result.rows);

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: err.message });

    }

});
const otpGenerator = require("otp-generator");

app.post("/send-otp", async (req, res) => {

    const { phone } = req.body;

    if (!phone)
        return res.status(400).json({ error: "Phone required" });

    const otp = otpGenerator.generate(6, {
        digits: true,
        upperCaseAlphabets: false,
        lowerCaseAlphabets: false,
        specialChars: false
    });

    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + 5);

    await pool.query(
        "INSERT INTO otp_codes (phone, otp, expires_at) VALUES ($1,$2,$3)",
        [phone, otp, expiry]
    );

    console.log("OTP:", otp);

    res.json({ message: "OTP sent" });

});


app.post("/send-otp", async (req, res) => {

    const { phone } = req.body;

    if (!phone)
        return res.status(400).json({ error: "Phone required" });

    const otp = otpGenerator.generate(6, {
        digits: true,
        upperCaseAlphabets: false,
        lowerCaseAlphabets: false,
        specialChars: false
    });

    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + 5);

    await pool.query(
        "INSERT INTO otp_codes (phone, otp, expires_at) VALUES ($1,$2,$3)",
        [phone, otp, expiry]
    );

    console.log("OTP:", otp);

    res.json({ message: "OTP sent" });

});

/* ================= START SERVER ================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log("Smart Library Server running on port " + PORT);
});