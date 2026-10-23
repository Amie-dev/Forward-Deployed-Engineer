import { z } from "zod";

const MeetingDetails = z.object({
  title: z.string(),
  attendee: z.string(),
  date: z.string(),
  time: z.string(),
  durationMinutes: z.number().int(),
});

export default MeetingDetails;
