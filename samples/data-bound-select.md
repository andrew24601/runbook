# Data-bound Select

This sample loads users from an API, binds a select to the returned JSON, and uses the selected user ID in a follow-up request.

```variables name="env"
base_url = "https://jsonplaceholder.typicode.com"
```

Fetch the option source first.

```http name="users" auto="true"
GET {{env.base_url}}/users
Accept: application/json
```

Bind the select to the cached HTTP response. The dropdown displays `name` and stores `id`.

```variables name="selection"
user_id = {
  "type": "select",
  "options": "$.users.body[*]",
  "label": "name",
  "value": "id",
  "default": 1
}
```

The selected value is a normal variable, so it can drive later requests.

```http name="todos" auto="true"
GET {{env.base_url}}/todos?userId={{selection.user_id}}
Accept: application/json
```

```json src="todos.body"
```

```javascript name="todoSummary"
return {
  count: Array.isArray(todos.body) ? todos.body.length : 0
};
```

- Selected user ID: {{selection.user_id}}
- Loaded todos: {{todoSummary.count}}
