import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import MeetingDetails from "./MeetingDetails.js";

class MeetingService {
  constructor() {
    this.openai = new OpenAI();
  }

  async schedule(message) {
    const today = new Date().toLocaleDateString("en-CA");
    const systemPrompt = `
      You extract meeting information from the user's request.

      Today's date is ${today}.

      Rules:

      - Convert relative dates like today and tomorrow
        into yyyy-MM-dd format.

      - Convert time into 24-hour HH:mm format.

      - If title is missing, create a simple title.

      - If duration is missing, use 30 minutes.

      - Do not invent attendee, date or time.

      - If information is missing, keep it blank.
    `;

    const response = await this.openai.responses.parse({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      text: {
        format: zodTextFormat(MeetingDetails, "meeting_details"),
      },
    });

    return response.output_parsed;
  }
}

export default MeetingService;
