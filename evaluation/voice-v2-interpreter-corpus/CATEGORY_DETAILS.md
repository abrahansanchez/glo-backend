# Per-category metrics

N/A means no eligible denominator. Ambiguous cases are separate; unsafe counts include them.

## affirmative

| Metric | Result |
| --- | --- |
| Cases | 8 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 2/8 (25%) |
| Strict accuracy | 2/8 (25%) |
| Intent recall | 2/8 (25%) |
| Intent precision | 2/3 (66.67%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 5/8 (62.5%) |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 8/8 (100%) | 8/8 (100%) |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | 8/8 (100%) |
| confirmation | 2/8 (25%) | 2/8 (25%) |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 2/8 (25%) | 2/2 (100%) |
| BOOK_REQUEST | N/A | 0/1 (0%) |

## alternative_rejection

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 0/6 (0%) |
| Strict accuracy | 0/6 (0%) |
| Intent recall | 0/8 (0%) |
| Intent precision | N/A |
| Appropriate clarification | 4/4 (100%) |
| Unnecessary clarification | 2/2 (100%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | N/A |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 4/6 (66.67%) | 0/2 (0%) |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| REJECT_ALTERNATIVES | 0/6 (0%) | N/A |
| REQUEST_AVAILABILITY | 0/2 (0%) | N/A |

## alternative_selection

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 6/6 (100%) |
| Strict accuracy | 5/6 (83.33%) |
| Intent recall | 12/12 (100%) |
| Intent precision | 12/12 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 0/6 (0%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 1 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 5/6 (83.33%) | 5/6 (83.33%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| SELECT_ALTERNATIVE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## availability_only

| Metric | Result |
| --- | --- |
| Cases | 8 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 5/8 (62.5%) |
| Strict accuracy | 1/8 (12.5%) |
| Intent recall | 13/16 (81.25%) |
| Intent precision | 13/13 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 3/8 (37.5%) |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 8/8 (100%) | N/A |
| daypart | 1/8 (12.5%) | 1/8 (12.5%) |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | N/A |
| confirmation | 8/8 (100%) | N/A |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| REQUEST_AVAILABILITY | 5/8 (62.5%) | 5/5 (100%) |
| SET_DATE | 8/8 (100%) | 8/8 (100%) |

## background_fragment

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 0 / 6 |
| Complete intents | N/A |
| Strict accuracy | N/A |
| Intent recall | N/A |
| Intent precision | N/A |
| Appropriate clarification | N/A |
| Unnecessary clarification | N/A |
| Hallucination | N/A |
| Unsafe turns | 2 |

| Slot | All | Populated |
| --- | --- | --- |
| service | N/A | N/A |
| additionalServices | N/A | N/A |
| date | N/A | N/A |
| exactTime | N/A | N/A |
| daypart | N/A | N/A |
| lowerBound | N/A | N/A |
| upperBound | N/A | N/A |
| name | N/A | N/A |
| confirmation | N/A | N/A |
| correctionTarget | N/A | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |


## compound_services

| Metric | Result |
| --- | --- |
| Cases | 8 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 2/8 (25%) |
| Strict accuracy | 2/8 (25%) |
| Intent recall | 10/16 (62.5%) |
| Intent precision | 10/10 (100%) |
| Appropriate clarification | 8/8 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | 8/8 (100%) |
| date | 8/8 (100%) | N/A |
| exactTime | 8/8 (100%) | N/A |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | N/A |
| confirmation | 8/8 (100%) | N/A |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 2/8 (25%) | 2/2 (100%) |
| SET_SERVICE | 8/8 (100%) | 8/8 (100%) |

## confirmation_question

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 0/6 (0%) |
| Strict accuracy | 0/6 (0%) |
| Intent recall | 0/6 (0%) |
| Intent precision | 0/4 (0%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 2/6 (33.33%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 2 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 4/6 (66.67%) | 4/6 (66.67%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 4/6 (66.67%) | N/A |
| correctionTarget | 4/6 (66.67%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| CORRECT_SERVICE | N/A | 0/2 (0%) |
| QUESTION_ABOUT_CONFIRMATION | 0/6 (0%) | N/A |
| REPEAT_INFORMATION | N/A | 0/2 (0%) |

## correction_with_availability

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 0/6 (0%) |
| Strict accuracy | 0/6 (0%) |
| Intent recall | 3/12 (25%) |
| Intent precision | 3/5 (60%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 5/6 (83.33%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 2/6 (33.33%) | 2/6 (33.33%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | N/A |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 2/6 (33.33%) | 2/6 (33.33%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| CORRECT_SERVICE | 2/6 (33.33%) | 2/2 (100%) |
| REPEAT_INFORMATION | N/A | 0/2 (0%) |
| REQUEST_AVAILABILITY | 1/6 (16.67%) | 1/1 (100%) |

## date_correction

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 2/6 (33.33%) |
| Strict accuracy | 2/6 (33.33%) |
| Intent recall | 2/6 (33.33%) |
| Intent precision | 2/4 (50%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 2/6 (33.33%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 2/6 (33.33%) | 2/6 (33.33%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 4/6 (66.67%) | N/A |
| correctionTarget | 2/6 (33.33%) | 2/6 (33.33%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| CORRECT_DATE | 2/6 (33.33%) | 2/2 (100%) |
| REPEAT_INFORMATION | N/A | 0/2 (0%) |

## daypart

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 6/6 (100%) |
| Strict accuracy | 6/6 (100%) |
| Intent recall | 6/6 (100%) |
| Intent precision | 6/6 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 0/6 (0%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | N/A |
| daypart | 6/6 (100%) | 6/6 (100%) |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| REQUEST_AVAILABILITY | 6/6 (100%) | 6/6 (100%) |

## denial

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 2/6 (33.33%) |
| Strict accuracy | 0/6 (0%) |
| Intent recall | 2/6 (33.33%) |
| Intent precision | 2/3 (66.67%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 5/6 (83.33%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 2/6 (33.33%) | 2/6 (33.33%) |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | N/A | 0/1 (0%) |
| DENY_CONFIRMATION | 2/6 (33.33%) | 2/2 (100%) |

## dialogue_availability_selection

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 16 / 16 / 0 |
| Complete intents | 8/16 (50%) |
| Strict accuracy | 8/16 (50%) |
| Intent recall | 24/32 (75%) |
| Intent precision | 24/24 (100%) |
| Appropriate clarification | 4/4 (100%) |
| Unnecessary clarification | 4/12 (33.33%) |
| Hallucination | 0/16 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 16/16 (100%) | 16/16 (100%) |
| additionalServices | 16/16 (100%) | N/A |
| date | 16/16 (100%) | 16/16 (100%) |
| exactTime | 16/16 (100%) | 12/12 (100%) |
| daypart | 16/16 (100%) | N/A |
| lowerBound | 16/16 (100%) | N/A |
| upperBound | 16/16 (100%) | N/A |
| name | 16/16 (100%) | 8/8 (100%) |
| confirmation | 12/16 (75%) | 0/4 (0%) |
| correctionTarget | 16/16 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | 0/4 (0%) | N/A |
| REQUEST_AVAILABILITY | 4/4 (100%) | 4/4 (100%) |
| SELECT_ALTERNATIVE | 4/4 (100%) | 4/4 (100%) |
| SET_DATE | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_TIME | 4/4 (100%) | 4/4 (100%) |

## dialogue_compound_removal

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 24 / 24 / 0 |
| Complete intents | 20/24 (83.33%) |
| Strict accuracy | 20/24 (83.33%) |
| Intent recall | 24/28 (85.71%) |
| Intent precision | 24/24 (100%) |
| Appropriate clarification | 16/16 (100%) |
| Unnecessary clarification | 4/8 (50%) |
| Hallucination | 0/24 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 24/24 (100%) | 24/24 (100%) |
| additionalServices | 24/24 (100%) | 4/4 (100%) |
| date | 24/24 (100%) | 16/16 (100%) |
| exactTime | 24/24 (100%) | 12/12 (100%) |
| daypart | 24/24 (100%) | N/A |
| lowerBound | 24/24 (100%) | N/A |
| upperBound | 24/24 (100%) | N/A |
| name | 24/24 (100%) | 8/8 (100%) |
| confirmation | 20/24 (83.33%) | 0/4 (0%) |
| correctionTarget | 24/24 (100%) | 4/4 (100%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | 4/4 (100%) | 4/4 (100%) |
| CORRECT_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_DATE | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_TIME | 4/4 (100%) | 4/4 (100%) |

## dialogue_confirmation_affirm

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 0/8 (0%) |
| Strict accuracy | 0/8 (0%) |
| Intent recall | 0/8 (0%) |
| Intent precision | 0/2 (0%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 6/8 (75%) |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 8/8 (100%) | 8/8 (100%) |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | 8/8 (100%) |
| confirmation | 2/8 (25%) | 0/4 (0%) |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | N/A | 0/2 (0%) |
| QUESTION_ABOUT_CONFIRMATION | 0/4 (0%) | N/A |

## dialogue_confirmation_deny

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 4/8 (50%) |
| Strict accuracy | 4/8 (50%) |
| Intent recall | 4/8 (50%) |
| Intent precision | 4/4 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 4/8 (50%) |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 8/8 (100%) | 8/8 (100%) |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | 8/8 (100%) |
| confirmation | 4/8 (50%) | 0/4 (0%) |
| correctionTarget | 8/8 (100%) | 4/4 (100%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| CORRECT_TIME | 4/4 (100%) | 4/4 (100%) |
| DENY_CONFIRMATION | 0/4 (0%) | N/A |

## dialogue_confirmation_question

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 0/8 (0%) |
| Strict accuracy | 0/8 (0%) |
| Intent recall | 0/8 (0%) |
| Intent precision | 0/2 (0%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 6/8 (75%) |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 8/8 (100%) | 8/8 (100%) |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | 8/8 (100%) |
| confirmation | 0/8 (0%) | 0/4 (0%) |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | N/A | 0/2 (0%) |
| DENY_CONFIRMATION | 0/4 (0%) | N/A |
| QUESTION_ABOUT_CONFIRMATION | 0/4 (0%) | N/A |

## dialogue_date_service

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 20 / 20 / 0 |
| Complete intents | 16/20 (80%) |
| Strict accuracy | 16/20 (80%) |
| Intent recall | 16/20 (80%) |
| Intent precision | 16/18 (88.89%) |
| Appropriate clarification | 12/12 (100%) |
| Unnecessary clarification | 4/8 (50%) |
| Hallucination | 0/20 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 20/20 (100%) | 16/16 (100%) |
| additionalServices | 20/20 (100%) | N/A |
| date | 20/20 (100%) | 20/20 (100%) |
| exactTime | 20/20 (100%) | 12/12 (100%) |
| daypart | 20/20 (100%) | N/A |
| lowerBound | 20/20 (100%) | N/A |
| upperBound | 20/20 (100%) | N/A |
| name | 20/20 (100%) | 8/8 (100%) |
| confirmation | 16/20 (80%) | 0/4 (0%) |
| correctionTarget | 20/20 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | N/A | 0/2 (0%) |
| SET_DATE | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_TIME | 4/4 (100%) | 4/4 (100%) |

## dialogue_language_switch

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 20 / 20 / 0 |
| Complete intents | 16/20 (80%) |
| Strict accuracy | 16/20 (80%) |
| Intent recall | 16/20 (80%) |
| Intent precision | 16/18 (88.89%) |
| Appropriate clarification | 12/12 (100%) |
| Unnecessary clarification | 4/8 (50%) |
| Hallucination | 0/20 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 20/20 (100%) | 20/20 (100%) |
| additionalServices | 20/20 (100%) | N/A |
| date | 20/20 (100%) | 16/16 (100%) |
| exactTime | 20/20 (100%) | 12/12 (100%) |
| daypart | 20/20 (100%) | N/A |
| lowerBound | 20/20 (100%) | N/A |
| upperBound | 20/20 (100%) | N/A |
| name | 20/20 (100%) | 8/8 (100%) |
| confirmation | 16/20 (80%) | 0/4 (0%) |
| correctionTarget | 20/20 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | N/A | 0/2 (0%) |
| SET_DATE | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_TIME | 4/4 (100%) | 4/4 (100%) |

## dialogue_name_correction

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 12 / 12 / 0 |
| Complete intents | 8/12 (66.67%) |
| Strict accuracy | 8/12 (66.67%) |
| Intent recall | 8/12 (66.67%) |
| Intent precision | 8/8 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 4/12 (33.33%) |
| Hallucination | 0/12 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 12/12 (100%) | 12/12 (100%) |
| additionalServices | 12/12 (100%) | N/A |
| date | 12/12 (100%) | 12/12 (100%) |
| exactTime | 12/12 (100%) | 12/12 (100%) |
| daypart | 12/12 (100%) | N/A |
| lowerBound | 12/12 (100%) | N/A |
| upperBound | 12/12 (100%) | N/A |
| name | 12/12 (100%) | 12/12 (100%) |
| confirmation | 8/12 (66.67%) | 0/4 (0%) |
| correctionTarget | 12/12 (100%) | 4/4 (100%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| CORRECT_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |

## dialogue_paused

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 24 / 24 / 0 |
| Complete intents | 20/24 (83.33%) |
| Strict accuracy | 20/24 (83.33%) |
| Intent recall | 16/20 (80%) |
| Intent precision | 16/18 (88.89%) |
| Appropriate clarification | 12/12 (100%) |
| Unnecessary clarification | 4/12 (33.33%) |
| Hallucination | 0/24 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 24/24 (100%) | 24/24 (100%) |
| additionalServices | 24/24 (100%) | N/A |
| date | 24/24 (100%) | 20/20 (100%) |
| exactTime | 24/24 (100%) | 12/12 (100%) |
| daypart | 24/24 (100%) | N/A |
| lowerBound | 24/24 (100%) | N/A |
| upperBound | 24/24 (100%) | N/A |
| name | 24/24 (100%) | 8/8 (100%) |
| confirmation | 20/24 (83.33%) | 0/4 (0%) |
| correctionTarget | 24/24 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | N/A | 0/2 (0%) |
| SET_DATE | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_TIME | 4/4 (100%) | 4/4 (100%) |

## dialogue_service_date

| Metric | Result |
| --- | --- |
| Cases | 4 |
| Turns / unambiguous / ambiguous | 20 / 20 / 0 |
| Complete intents | 16/20 (80%) |
| Strict accuracy | 16/20 (80%) |
| Intent recall | 16/20 (80%) |
| Intent precision | 16/18 (88.89%) |
| Appropriate clarification | 12/12 (100%) |
| Unnecessary clarification | 4/8 (50%) |
| Hallucination | 0/20 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 20/20 (100%) | 20/20 (100%) |
| additionalServices | 20/20 (100%) | N/A |
| date | 20/20 (100%) | 16/16 (100%) |
| exactTime | 20/20 (100%) | 12/12 (100%) |
| daypart | 20/20 (100%) | N/A |
| lowerBound | 20/20 (100%) | N/A |
| upperBound | 20/20 (100%) | N/A |
| name | 20/20 (100%) | 8/8 (100%) |
| confirmation | 16/20 (80%) | 0/4 (0%) |
| correctionTarget | 20/20 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 0/4 (0%) | N/A |
| BOOK_REQUEST | N/A | 0/2 (0%) |
| SET_DATE | 4/4 (100%) | 4/4 (100%) |
| SET_NAME | 4/4 (100%) | 4/4 (100%) |
| SET_SERVICE | 4/4 (100%) | 4/4 (100%) |
| SET_TIME | 4/4 (100%) | 4/4 (100%) |

## direct_booking

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 4/6 (66.67%) |
| Strict accuracy | 4/6 (66.67%) |
| Intent recall | 22/24 (91.67%) |
| Intent precision | 22/22 (100%) |
| Appropriate clarification | 6/6 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 4/6 (66.67%) | 4/6 (66.67%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 6/6 (100%) | 6/6 (100%) |
| SET_DATE | 4/6 (66.67%) | 4/4 (100%) |
| SET_SERVICE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## early_opening

| Metric | Result |
| --- | --- |
| Cases | 16 |
| Turns / unambiguous / ambiguous | 16 / 16 / 0 |
| Complete intents | 0/16 (0%) |
| Strict accuracy | 0/16 (0%) |
| Intent recall | 2/32 (6.25%) |
| Intent precision | 2/8 (25%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 14/16 (87.5%) |
| Hallucination | 0/16 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 16/16 (100%) | 16/16 (100%) |
| additionalServices | 16/16 (100%) | N/A |
| date | 16/16 (100%) | 16/16 (100%) |
| exactTime | 16/16 (100%) | N/A |
| daypart | 0/16 (0%) | 0/16 (0%) |
| lowerBound | 16/16 (100%) | N/A |
| upperBound | 16/16 (100%) | N/A |
| name | 16/16 (100%) | N/A |
| confirmation | 16/16 (100%) | N/A |
| correctionTarget | 16/16 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | N/A | 0/1 (0%) |
| EARLIEST_AVAILABLE | 0/16 (0%) | N/A |
| REPEAT_INFORMATION | N/A | 0/5 (0%) |
| REQUEST_AVAILABILITY | 2/16 (12.5%) | 2/2 (100%) |

## embedded_availability

| Metric | Result |
| --- | --- |
| Cases | 12 |
| Turns / unambiguous / ambiguous | 12 / 12 / 0 |
| Complete intents | 0/12 (0%) |
| Strict accuracy | 0/12 (0%) |
| Intent recall | 35/48 (72.92%) |
| Intent precision | 35/35 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 3/12 (25%) |
| Hallucination | 0/12 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 11/12 (91.67%) | 11/12 (91.67%) |
| additionalServices | 12/12 (100%) | N/A |
| date | 11/12 (91.67%) | 11/12 (91.67%) |
| exactTime | 12/12 (100%) | N/A |
| daypart | 9/12 (75%) | 1/4 (25%) |
| lowerBound | 12/12 (100%) | N/A |
| upperBound | 12/12 (100%) | N/A |
| name | 12/12 (100%) | N/A |
| confirmation | 12/12 (100%) | N/A |
| correctionTarget | 12/12 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 2/12 (16.67%) | 2/2 (100%) |
| REQUEST_AVAILABILITY | 10/12 (83.33%) | 10/10 (100%) |
| SET_DATE | 12/12 (100%) | 12/12 (100%) |
| SET_SERVICE | 11/12 (91.67%) | 11/11 (100%) |

## facts_order

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 6/6 (100%) |
| Strict accuracy | 6/6 (100%) |
| Intent recall | 24/24 (100%) |
| Intent precision | 24/24 (100%) |
| Appropriate clarification | 6/6 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 6/6 (100%) | 6/6 (100%) |
| SET_DATE | 6/6 (100%) | 6/6 (100%) |
| SET_SERVICE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## informal_filler

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 4/6 (66.67%) |
| Strict accuracy | 4/6 (66.67%) |
| Intent recall | 22/24 (91.67%) |
| Intent precision | 22/22 (100%) |
| Appropriate clarification | 6/6 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 4/6 (66.67%) | 4/6 (66.67%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 6/6 (100%) | 6/6 (100%) |
| SET_DATE | 4/6 (66.67%) | 4/4 (100%) |
| SET_SERVICE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## language_mismatch

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 6/6 (100%) |
| Strict accuracy | 6/6 (100%) |
| Intent recall | 24/24 (100%) |
| Intent precision | 24/24 (100%) |
| Appropriate clarification | 6/6 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 6/6 (100%) | 6/6 (100%) |
| SET_DATE | 6/6 (100%) | 6/6 (100%) |
| SET_SERVICE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## missing_information

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 6/6 (100%) |
| Strict accuracy | 6/6 (100%) |
| Intent recall | 10/10 (100%) |
| Intent precision | 10/10 (100%) |
| Appropriate clarification | 6/6 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 2/2 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 2/2 (100%) |
| exactTime | 6/6 (100%) | 2/2 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 4/4 (100%) | 4/4 (100%) |
| SET_DATE | 2/2 (100%) | 2/2 (100%) |
| SET_SERVICE | 2/2 (100%) | 2/2 (100%) |
| SET_TIME | 2/2 (100%) | 2/2 (100%) |

## multiple_facts

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 3/6 (50%) |
| Strict accuracy | 1/6 (16.67%) |
| Intent recall | 26/30 (86.67%) |
| Intent precision | 26/26 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 3/6 (50%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 4/6 (66.67%) | 4/6 (66.67%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 1/6 (16.67%) | 1/6 (16.67%) |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 6/6 (100%) | 6/6 (100%) |
| SET_DATE | 4/6 (66.67%) | 4/4 (100%) |
| SET_NAME | 4/6 (66.67%) | 4/4 (100%) |
| SET_SERVICE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## name_correction

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 3/6 (50%) |
| Strict accuracy | 3/6 (50%) |
| Intent recall | 3/6 (50%) |
| Intent precision | 3/3 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 3/6 (50%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 3/6 (50%) | 3/6 (50%) |
| confirmation | 3/6 (50%) | N/A |
| correctionTarget | 3/6 (50%) | 3/6 (50%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| CORRECT_NAME | 3/6 (50%) | 3/3 (100%) |

## non_time_numbers

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 0/6 (0%) |
| Strict accuracy | 0/6 (0%) |
| Intent recall | 0/6 (0%) |
| Intent precision | 0/4 (0%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 2/6 (33.33%) |
| Hallucination | 4/6 (66.67%) |
| Unsafe turns | 4 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 2/6 (33.33%) | N/A |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| SET_TIME | N/A | 0/4 (0%) |
| UNRELATED_INFORMATION | 0/6 (0%) | N/A |

## pause_fragment

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 4/6 (66.67%) |
| Strict accuracy | 4/6 (66.67%) |
| Intent recall | 22/24 (91.67%) |
| Intent precision | 22/22 (100%) |
| Appropriate clarification | 6/6 (100%) |
| Unnecessary clarification | N/A |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 4/6 (66.67%) | 4/6 (66.67%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | N/A |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | 6/6 (100%) | 6/6 (100%) |
| SET_DATE | 4/6 (66.67%) | 4/4 (100%) |
| SET_SERVICE | 6/6 (100%) | 6/6 (100%) |
| SET_TIME | 6/6 (100%) | 6/6 (100%) |

## repeated_information

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 6/6 (100%) |
| Strict accuracy | 6/6 (100%) |
| Intent recall | 6/6 (100%) |
| Intent precision | 6/6 (100%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 0/6 (0%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 6/6 (100%) | 6/6 (100%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 6/6 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| REPEAT_INFORMATION | 6/6 (100%) | 6/6 (100%) |

## service_correction

| Metric | Result |
| --- | --- |
| Cases | 8 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 4/8 (50%) |
| Strict accuracy | 3/8 (37.5%) |
| Intent recall | 4/8 (50%) |
| Intent precision | 4/5 (80%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 3/8 (37.5%) |
| Hallucination | 0/8 (0%) |
| Unsafe turns | 1 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 7/8 (87.5%) | 7/8 (87.5%) |
| additionalServices | 3/8 (37.5%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 8/8 (100%) | 8/8 (100%) |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | 8/8 (100%) |
| confirmation | 5/8 (62.5%) | N/A |
| correctionTarget | 4/8 (50%) | 4/8 (50%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| BOOK_REQUEST | N/A | 0/1 (0%) |
| CORRECT_SERVICE | 4/8 (50%) | 4/4 (100%) |

## time_bounds

| Metric | Result |
| --- | --- |
| Cases | 8 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 6/8 (75%) |
| Strict accuracy | 6/8 (75%) |
| Intent recall | 6/8 (75%) |
| Intent precision | 6/10 (60%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 0/8 (0%) |
| Hallucination | 2/8 (25%) |
| Unsafe turns | 2 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 6/8 (75%) | N/A |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | 6/6 (100%) |
| upperBound | 6/8 (75%) | 0/2 (0%) |
| name | 8/8 (100%) | 8/8 (100%) |
| confirmation | 8/8 (100%) | N/A |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| REQUEST_AVAILABILITY | 6/8 (75%) | 6/6 (100%) |
| SELECT_ALTERNATIVE | N/A | 0/2 (0%) |
| SET_TIME | N/A | 0/2 (0%) |

## time_correction

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 6 / 0 |
| Complete intents | 5/6 (83.33%) |
| Strict accuracy | 5/6 (83.33%) |
| Intent recall | 5/6 (83.33%) |
| Intent precision | 5/6 (83.33%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 0/6 (0%) |
| Hallucination | 0/6 (0%) |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 6/6 (100%) | 6/6 (100%) |
| additionalServices | 6/6 (100%) | N/A |
| date | 6/6 (100%) | 6/6 (100%) |
| exactTime | 5/6 (83.33%) | 5/6 (83.33%) |
| daypart | 6/6 (100%) | N/A |
| lowerBound | 6/6 (100%) | N/A |
| upperBound | 6/6 (100%) | N/A |
| name | 6/6 (100%) | 6/6 (100%) |
| confirmation | 6/6 (100%) | N/A |
| correctionTarget | 5/6 (83.33%) | 5/6 (83.33%) |

| Intent | Recall | Precision |
| --- | --- | --- |
| CORRECT_TIME | 5/6 (83.33%) | 5/5 (100%) |
| REPEAT_INFORMATION | N/A | 0/1 (0%) |

## transcription_artifact

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 0 / 6 |
| Complete intents | N/A |
| Strict accuracy | N/A |
| Intent recall | N/A |
| Intent precision | N/A |
| Appropriate clarification | N/A |
| Unnecessary clarification | N/A |
| Hallucination | N/A |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | N/A | N/A |
| additionalServices | N/A | N/A |
| date | N/A | N/A |
| exactTime | N/A | N/A |
| daypart | N/A | N/A |
| lowerBound | N/A | N/A |
| upperBound | N/A | N/A |
| name | N/A | N/A |
| confirmation | N/A | N/A |
| correctionTarget | N/A | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |


## uncertain_consent

| Metric | Result |
| --- | --- |
| Cases | 6 |
| Turns / unambiguous / ambiguous | 6 / 0 / 6 |
| Complete intents | N/A |
| Strict accuracy | N/A |
| Intent recall | N/A |
| Intent precision | N/A |
| Appropriate clarification | N/A |
| Unnecessary clarification | N/A |
| Hallucination | N/A |
| Unsafe turns | 0 |

| Slot | All | Populated |
| --- | --- | --- |
| service | N/A | N/A |
| additionalServices | N/A | N/A |
| date | N/A | N/A |
| exactTime | N/A | N/A |
| daypart | N/A | N/A |
| lowerBound | N/A | N/A |
| upperBound | N/A | N/A |
| name | N/A | N/A |
| confirmation | N/A | N/A |
| correctionTarget | N/A | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |


## unrelated_question

| Metric | Result |
| --- | --- |
| Cases | 8 |
| Turns / unambiguous / ambiguous | 8 / 8 / 0 |
| Complete intents | 0/8 (0%) |
| Strict accuracy | 0/8 (0%) |
| Intent recall | 0/8 (0%) |
| Intent precision | 0/4 (0%) |
| Appropriate clarification | N/A |
| Unnecessary clarification | 4/8 (50%) |
| Hallucination | 4/8 (50%) |
| Unsafe turns | 4 |

| Slot | All | Populated |
| --- | --- | --- |
| service | 8/8 (100%) | 8/8 (100%) |
| additionalServices | 8/8 (100%) | N/A |
| date | 8/8 (100%) | 8/8 (100%) |
| exactTime | 4/8 (50%) | N/A |
| daypart | 8/8 (100%) | N/A |
| lowerBound | 8/8 (100%) | N/A |
| upperBound | 8/8 (100%) | N/A |
| name | 8/8 (100%) | N/A |
| confirmation | 8/8 (100%) | N/A |
| correctionTarget | 8/8 (100%) | N/A |

| Intent | Recall | Precision |
| --- | --- | --- |
| SET_TIME | N/A | 0/4 (0%) |
| UNRELATED_QUESTION | 0/8 (0%) | N/A |
