import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { supabase } from "@/lib/supabase";

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      userId,
      email,
      injuryProfileId,
      injuryType,
      exercisePlan,
      reminderType = "exercise",
      scheduledAt,
    } = body;

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const emailContent = buildEmailContent(reminderType, injuryType, exercisePlan);

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: "Recover <hello@optimalemails.xyz>",
      replyTo: "recover@optimalemails.xyz",
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
    });

    if (emailError) {
      throw new Error(`Email send failed: ${emailError.message}`);
    }

    // Log reminder in Supabase
    if (userId) {
      await supabase.from("reminders").insert({
        user_id: userId,
        injury_profile_id: injuryProfileId,
        email,
        reminder_type: reminderType,
        scheduled_at: scheduledAt || new Date().toISOString(),
        sent_at: new Date().toISOString(),
        resend_id: emailData?.id,
      });
    }

    return NextResponse.json({ success: true, emailId: emailData?.id });
  } catch (error) {
    console.error("send-reminder error:", error);
    return NextResponse.json(
      { error: "Failed to send reminder", details: String(error) },
      { status: 500 }
    );
  }
}

function buildEmailContent(
  type: string,
  injuryType: string,
  exercisePlan: Array<{ name: string; description: string; reps: string }>
) {
  const exerciseListHtml =
    exercisePlan && exercisePlan.length > 0
      ? `<ul style="padding-left: 20px;">
          ${exercisePlan
            .map(
              (ex) =>
                `<li style="margin-bottom: 12px;">
              <strong>${ex.name}</strong><br/>
              ${ex.description}<br/>
              <span style="color: #6366f1;">Reps/Duration: ${ex.reps}</span>
            </li>`
            )
            .join("")}
        </ul>`
      : "<p>Check your app for your personalized exercise plan.</p>";

  const templates: Record<string, { subject: string; html: string }> = {
    exercise: {
      subject: `Time for your recovery exercises 💪`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #6366f1;">Time for your recovery exercises!</h2>
          <p>You're making great progress recovering from <strong>${injuryType || "your injury"}</strong>. Consistency is key!</p>
          <h3>Today's Exercise Plan:</h3>
          ${exerciseListHtml}
          <div style="background: #f0f9ff; border-radius: 8px; padding: 16px; margin-top: 24px;">
            <p style="margin: 0; color: #0369a1;">
              <strong>Remember:</strong> Stop if you feel sharp pain. Listen to your body and progress at your own pace.
            </p>
          </div>
          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            Open the Recover app to log your session and upload a video for form feedback.
          </p>
        </div>
      `,
    },
    followup: {
      subject: `Recovery check-in — How are you feeling?`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #6366f1;">How's your recovery going?</h2>
          <p>It's been a few days since you started your recovery plan for <strong>${injuryType || "your injury"}</strong>.</p>
          <p>Open the Recover app to:</p>
          <ul>
            <li>Log how you're feeling today</li>
            <li>Submit an exercise video for AI form analysis</li>
            <li>View your progress over time</li>
          </ul>
          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            Consistency leads to faster recovery. Keep it up!
          </p>
        </div>
      `,
    },
    checkup: {
      subject: `Weekly recovery summary`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #6366f1;">Your weekly recovery summary</h2>
          <p>Great work this week on your <strong>${injuryType || "injury"}</strong> recovery!</p>
          <p>Log into the Recover app to see your detailed progress report and updated exercise recommendations.</p>
        </div>
      `,
    },
  };

  return templates[type] || templates.exercise;
}
