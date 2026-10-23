import MeetingService from "./MeetingService.js";

const meetingService = new MeetingService();

const meetingDetails = await meetingService.schedule(
  "Schedule a project review with Aditya tomorrow at 3 PM for 45 minutes.",
);

console.log(meetingDetails);
