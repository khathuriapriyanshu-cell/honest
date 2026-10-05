/**
 * HONEST Backend 2 (KBAI) - Comprehensive Verification Test Suite
 * 
 * Verifies all business logic, database operations, and API contracts.
 */

const { getDatabase } = require('./database');
const timeService = require('./services/timeService');
const accountabilityService = require('./services/accountabilityService');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS: ${message}`);
}

async function runTests() {
  console.log('--- Starting HONEST Backend 2 Verification Tests ---');

  // Test 1: Database Initialization
  console.log('\n[1] Verifying SQLite Database and Schema');
  const db = getDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert(tables.includes('tasks'), 'Tasks table exists');
  assert(tables.includes('task_completions'), 'Task completions table exists');
  assert(tables.includes('reflections'), 'Reflections table exists');
  assert(tables.includes('off_days'), 'Off-days table exists');
  assert(tables.includes('settings'), 'Settings table exists');

  // Test 2: Settings Defaults
  console.log('\n[2] Verifying Settings Defaults');
  const settings = accountabilityService.getSettings();
  assert(settings.accountabilityTime === '22:30', 'Default accountability time is 22:30');
  assert(settings.dailyReset === '00:00', 'Default daily reset is 00:00');
  assert(settings.gracePeriod === 15, 'Default grace period is 15 minutes');

  // Test 3: Task Creation (One-time, Daily, Selected Days)
  console.log('\n[3] Verifying Task Creation');
  const tz = 'UTC';
  const task1 = accountabilityService.createTask({
    title: 'Study Physics',
    definition: 'At least 45 minutes without phone',
    category: 'Study',
    repeat: 'once'
  }, tz);
  assert(task1.id && task1.title === 'Study Physics', 'Created one-time task');
  assert(task1.definition === 'At least 45 minutes without phone', 'Saved minimum completion definition');

  const task2 = accountabilityService.createTask({
    title: 'Daily Coding',
    definition: '2 hours LeetCode',
    category: 'DSA',
    repeat: 'daily'
  }, tz);
  assert(task2.repeat === 'daily', 'Created daily recurring task');

  const task3 = accountabilityService.createTask({
    title: 'Gym Workout',
    definition: 'Full pull routine',
    category: 'Workout',
    repeat: 'selected',
    selectedDays: [1, 3, 5]
  }, tz);
  assert(Array.isArray(task3.selectedDays), 'Created selected-days recurring task');

  // Test 4: Today State & Tasks Fetch
  console.log('\n[4] Verifying Today State & Task Retrieval');
  const todayDate = timeService.getTodayDate(tz);
  const tasksForToday = accountabilityService.getTasksForDate(todayDate, tz);
  assert(tasksForToday.length >= 2, `Retrieved today's tasks (found ${tasksForToday.length})`);
  assert(tasksForToday.some(t => t.id === task1.id), 'One-time task present on creation date');
  assert(tasksForToday.some(t => t.id === task2.id), 'Daily task present on today');

  // Test 5: Task Completion
  console.log('\n[5] Verifying Task Completion Toggle');
  accountabilityService.setTaskCompletion(task1.id, todayDate, true);
  const updatedTasks = accountabilityService.getTasksForDate(todayDate, tz);
  const completedTask = updatedTasks.find(t => t.id === task1.id);
  assert(completedTask.completed === true, 'Task marked as completed persistently');

  accountabilityService.setTaskCompletion(task1.id, todayDate, false);
  const revertedTasks = accountabilityService.getTasksForDate(todayDate, tz);
  const uncompletedTask = revertedTasks.find(t => t.id === task1.id);
  assert(uncompletedTask.completed === false, 'Task reverted to incomplete');

  // Re-complete task 1 for downstream score testing
  accountabilityService.setTaskCompletion(task1.id, todayDate, true);

  // Test 6: Off-Day Business Rules & Deadline Enforcement
  console.log('\n[6] Verifying Off-Day Eligibility & Deadline Enforcement');
  const pastDateCheck = timeService.isOffDayEligible('2025-01-01', '22:30', tz);
  assert(pastDateCheck.eligible === false, 'Retroactive off-day for past date correctly blocked');

  // Test 7: Reflection Submission
  console.log('\n[7] Verifying Reflection Submission');
  const refResult = accountabilityService.submitReflection(
    'Had a college event and returned late.',
    'Gym Workout',
    todayDate
  );
  assert(refResult.success === true, 'Reflection submitted and recorded');

  // Test 8: Archive & Pattern Notice
  console.log('\n[8] Verifying Honest Archive');
  const archive = accountabilityService.getArchive('event');
  assert(archive.reflections.length > 0, 'Found reflection matching search term');
  assert(archive.reflections[0].reason.includes('college event'), 'Reason preserved intact');

  // Test 9: Honest Score & Honest Days Calculation
  console.log('\n[9] Verifying Honest Score & Honest Days');
  const scoreStats = accountabilityService.getHonestyScore(tz);
  assert(typeof scoreStats.honestyScore === 'number', `Honesty score calculated: ${scoreStats.honestyScore}`);
  assert(scoreStats.promisesMade > 0, 'Promises made tracked in score stats');
  assert(scoreStats.completed > 0, 'Completions tracked in score stats');

  const honestDays = accountabilityService.calculateHonestDays(tz);
  assert(typeof honestDays === 'number', `Honest days count computed: ${honestDays}`);

  // Test 10: Weekly Report Calculation
  console.log('\n[10] Verifying Weekly Report Calculations');
  const report = accountabilityService.getWeeklyReport(tz);
  assert(typeof report.completionRate === 'number', `Completion rate computed: ${report.completionRate}%`);
  assert(typeof report.insight === 'string', `Schedule insight generated: "${report.insight}"`);

  // Summary
  console.log('\n===============================================');
  console.log(`ALL TESTS PASSED: ${passedTests} / ${totalTests} assertions passed!`);
  console.log('===============================================\n');
}

runTests().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
